import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_CAPABILITY_REGISTRY } from '@wiser/data-contracts';

import type {
  AgentExconHttpClient,
  AgentExconHttpRequest,
  JsonObject,
} from '../src/http-client.js';
import {
  createDataFoundationMcpModule,
  type DataFoundationHttpClient,
  type DataFoundationHttpRequest,
} from '../src/data-foundation/module.js';
import { DataFoundationApiError } from '../src/data-foundation/http-client.js';
import { createAgentExconMcpServer } from '../src/server.js';
import { candidateRelationPublicInputs } from './support/candidate-relations-public-fixture.ts';

const TENANT_ID = 'a1000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'a1000000-0000-4000-8000-000000000002';
const DATA_ITEM_ID = 'a1000000-0000-4000-8000-000000000003';
const VERSION_ID = 'a1000000-0000-4000-8000-000000000004';
const INGESTION_ID = 'a1000000-0000-4000-8000-000000000005';
const IDEMPOTENCY_KEY = 'a1000000-0000-4000-8000-000000000006';
const EVIDENCE_ID = 'a1000000-0000-4000-8000-000000000008';
const STAC_COLLECTION_ID = `wiser-${'a'.repeat(32)}`;
const STAC_ITEM_ID = `wiser-${'b'.repeat(48)}`;

const EXPECTED_DATA_TOOLS = [
  'data_catalog_search',
  'data_catalog_get',
  'data_query',
  'data_search_federated',
  'data_knowledge_search',
  'data_graph_expand',
  'data_graph_find_path',
  'data_geo_query',
  'data_geo_intersect',
  'data_ingestion_create',
  'data_ingestion_submit',
  'data_ingestion_resume',
  'data_operation_get',
  'data_catalog_create',
  'data_catalog_versions_list',
  'data_catalog_version_get',
  'data_upload_session_create',
  'data_upload_session_complete',
  'data_ingestion_get',
  'data_ingestion_candidate_get',
  'data_ingestion_candidate_records',
  'data_ingestion_candidate_geometry',
  'data_ingestion_candidate_provenance_get',
  'data_ingestion_candidate_followup_create',
  'data_ingestion_candidate_followup_get',
  'data_ingestion_candidate_followup_list',
  'data_ingestion_candidate_followup_act',
  'data_ingestion_candidate_followup_review',
  'data_ingestion_candidate_view_create',
  'data_ingestion_candidate_view_list',
  'data_ingestion_candidate_view_open',
  'data_ingestion_candidate_view_revoke',
  'data_ingestion_candidate_topic_create',
  'data_ingestion_candidate_topic_list',
  'data_ingestion_candidate_topic_open',
  'data_ingestion_candidate_relations_create',
  'data_ingestion_candidate_relations_get',
  'data_ingestion_candidate_relations_list',
  'data_ingestion_candidate_relations_review',
  'data_ingestion_candidate_relations_withdraw',
  'data_ingestion_candidate_relations_rebind',
  'data_ingestion_approve',
  'data_ingestion_reject',
  'data_operation_cancel',
  'data_operation_events',
  'data_explore_view_create',
  'data_explore_view_list',
  'data_explore_view_open',
  'data_explore_view_revoke',
  'data_explore_export',
  'data_explore_query',
  'data_analysis_create',
  'data_reconciliation_create',
  'data_reconciliation_get',
  'data_reconciliation_review',
  'data_reconciliation_list',
  'data_assessment_create',
  'data_assessment_get',
  'data_assessment_list',
  'data_assessment_overview',
  'data_knowledge_relations_import',
  'data_knowledge_relations_get',
  'data_knowledge_relations_list',
  'data_knowledge_relations_review',
  'data_external_metadata_read',
] as const;

class StubExconHttpClient implements AgentExconHttpClient {
  request(_request: AgentExconHttpRequest): Promise<JsonObject> {
    return Promise.resolve({ ok: true });
  }
}

class RecordingDataHttpClient implements DataFoundationHttpClient {
  readonly requests: DataFoundationHttpRequest[] = [];
  next: JsonObject = { items: [] };
  failure?: Error;

  request(request: DataFoundationHttpRequest): Promise<JsonObject> {
    this.requests.push(structuredClone(request));
    return this.failure === undefined
      ? Promise.resolve(this.next)
      : Promise.reject(this.failure);
  }
}

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connect(dataHttp: RecordingDataHttpClient): Promise<Client> {
  const server = createAgentExconMcpServer(new StubExconHttpClient(), {
    modules: [
      createDataFoundationMcpModule({
        http: dataHttp,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'analysis',
      }),
    ],
  });
  const client = new Client({ name: 'wiser-data-test', version: '0.1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  closeCallbacks.push(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  return client;
}

describe('Data Foundation MCP module', () => {
  it('exposes bounded private followup tool inputs and preserves strict action variants', async () => {
    const http = new RecordingDataHttpClient();
    const client = await connect(http);
    const tools = (await client.listTools()).tools;
    for (const name of ['create', 'act']) {
      const tool = tools.find(
        ({ name: toolName }) =>
          toolName === `data_ingestion_candidate_followup_${name}`,
      );
      expect(tool?.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(tool?.inputSchema.required).toContain('idempotencyKey');
      expect(tool?.inputSchema.required).toContain(
        name === 'create' ? 'type' : 'action',
      );
    }
    const reference = {
      kind: 'ingestion-candidate',
      ingestionId: INGESTION_ID,
      processingBatchId: VERSION_ID,
      reviewHash: 'a'.repeat(64),
    };
    const source = {
      reference,
      assetId: EVIDENCE_ID,
      sourceHash: 'b'.repeat(64),
      locator: `asset:${EVIDENCE_ID}`,
    };
    const valid: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        'create',
        {
          type: 'GAP',
          source,
          ruleId: 'coverage',
          ruleVersion: '1',
          reason: 'missing month',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      ['get', { followupId: DATA_ITEM_ID }],
      ['list', { ...reference, first: 2 }],
      [
        'act',
        {
          followupId: DATA_ITEM_ID,
          expectedVersion: 1,
          action: 'CLAIM',
          note: 'ownership',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      [
        'review',
        {
          followupId: DATA_ITEM_ID,
          expectedVersion: 4,
          decision: 'CLOSE',
          note: 'independent check',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
    ];
    for (const [name, args] of valid) {
      const result = await client.callTool({
        name: `data_ingestion_candidate_followup_${name}`,
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
    }
    expect(http.requests.map(({ path, method }) => [path, method])).toEqual([
      ['/ingestion-candidate-followups', 'POST'],
      [`/ingestion-candidate-followups/${DATA_ITEM_ID}`, 'GET'],
      ['/ingestion-candidate-followups', 'GET'],
      [`/ingestion-candidate-followups/${DATA_ITEM_ID}/act`, 'POST'],
      [`/ingestion-candidate-followups/${DATA_ITEM_ID}/review`, 'POST'],
    ]);
    expect(http.requests[2]?.query).toEqual({ ...reference, first: 2 });
    expect(http.requests[3]).toMatchObject({
      headers: { 'If-Match': '"v1"', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: { action: 'CLAIM', note: 'ownership' },
    });
    expect(http.requests[4]).toMatchObject({
      headers: { 'If-Match': '"v4"' },
      body: { decision: 'CLOSE', note: 'independent check' },
    });
    for (const [name, args] of [
      [
        'create',
        {
          type: 'CORRECTION',
          source,
          ruleId: 'location',
          ruleVersion: '1',
          reason: 'incorrect location',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      [
        'act',
        {
          followupId: DATA_ITEM_ID,
          expectedVersion: 1,
          action: 'CLAIM',
          targetActorId: EVIDENCE_ID,
          note: 'forbidden target',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      [
        'act',
        {
          followupId: DATA_ITEM_ID,
          expectedVersion: 1,
          action: 'HANDOFF',
          targetActorId: EVIDENCE_ID,
          targetType: 'human',
          note: 'authority injection',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
      [
        'act',
        {
          followupId: DATA_ITEM_ID,
          expectedVersion: 1,
          action: 'SUPPLEMENT',
          evidence: [],
          note: 'empty supplement',
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ],
    ] as const) {
      const denied = await client.callTool({
        name: `data_ingestion_candidate_followup_${name}`,
        arguments: args,
      });
      expect(denied.isError).toBe(true);
    }
    expect(http.requests).toHaveLength(5);
  });
  it('preserves the frozen candidate discovery reference from ingestion get without a published version', async () => {
    const http = new RecordingDataHttpClient();
    const reference = {
      kind: 'ingestion-candidate',
      ingestionId: INGESTION_ID,
      processingBatchId: VERSION_ID,
      reviewHash: 'e'.repeat(64),
    };
    http.next = {
      ingestion: { ingestionId: INGESTION_ID },
      candidateReference: reference,
    };
    const client = await connect(http);
    const result = await client.callTool({
      name: 'data_ingestion_get',
      arguments: { ingestionId: INGESTION_ID },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { candidateReference: reference },
    });
    expect(http.requests).toMatchObject([
      { method: 'GET', path: `/ingestions/${INGESTION_ID}` },
    ]);
    expect(JSON.stringify(result.structuredContent)).not.toContain('versionId');
  });
  it('reads a fixed conversion summary only through the standard HTTP tool', async () => {
    const http = new RecordingDataHttpClient();
    const reference = {
      kind: 'ingestion-candidate',
      ingestionId: INGESTION_ID,
      processingBatchId: VERSION_ID,
      reviewHash: 'e'.repeat(64),
    };
    const input = { ...reference, preparedAssetId: EVIDENCE_ID };
    http.next = { reference, preparedAssetId: EVIDENCE_ID, check: null };
    const client = await connect(http);
    const result = await client.callTool({
      name: 'data_ingestion_candidate_provenance_get',
      arguments: input,
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: http.next,
    });
    expect(http.requests).toEqual([
      {
        method: 'GET',
        path: `/ingestions/${INGESTION_ID}/candidates/${VERSION_ID}/${EVIDENCE_ID}/provenance`,
        headers: {
          'X-Wiser-Tenant-Id': TENANT_ID,
          'X-Wiser-Project-Id': PROJECT_ID,
          'X-Wiser-Purpose': 'analysis',
        },
        query: {
          kind: 'ingestion-candidate',
          reviewHash: reference.reviewHash,
        },
      },
    ]);
    const invalid = await client.callTool({
      name: 'data_ingestion_candidate_provenance_get',
      arguments: { ...input, verified: true },
    });
    expect(invalid.isError).toBe(true);
    expect(http.requests).toHaveLength(1);
  });

  it.each(['create', 'get', 'list', 'review', 'withdraw', 'rebind'] as const)(
    'forwards candidate relation %s through its precise HTTP route',
    async (operation) => {
      const http = new RecordingDataHttpClient(),
        client = await connect(http);
      const inputs = candidateRelationPublicInputs(
        {
          kind: 'ingestion-candidate',
          ingestionId: INGESTION_ID,
          processingBatchId: VERSION_ID,
          reviewHash: 'e'.repeat(64),
        },
        EVIDENCE_ID,
        DATA_ITEM_ID,
      );
      const input = inputs[`data.ingestion.candidate.relations.${operation}`];
      const writes = !['get', 'list'].includes(operation);
      const result = await client.callTool({
        name: `data_ingestion_candidate_relations_${operation}`,
        arguments: {
          ...input,
          ...(writes ? { idempotencyKey: IDEMPOTENCY_KEY } : {}),
        },
      });
      expect(result.isError).not.toBe(true);
      expect(http.requests).toHaveLength(1);
      const paths = {
        create: '/ingestion-candidate-relations',
        get: `/ingestion-candidate-relations/${DATA_ITEM_ID}/read`,
        list: '/ingestion-candidate-relations/list',
        review: `/ingestion-candidate-relations/${DATA_ITEM_ID}/review`,
        withdraw: `/ingestion-candidate-relations/${DATA_ITEM_ID}/withdraw`,
        rebind: `/ingestion-candidate-relations/${DATA_ITEM_ID}/rebind`,
      };
      const body = DATA_CAPABILITY_REGISTRY[
        `data.ingestion.candidate.relations.${operation}`
      ].inputSchema.parse(input) as Record<string, unknown>;
      delete body['relationId'];
      expect(http.requests[0]).toEqual({
        method: 'POST',
        path: paths[operation],
        headers: {
          'X-Wiser-Tenant-Id': TENANT_ID,
          'X-Wiser-Project-Id': PROJECT_ID,
          'X-Wiser-Purpose': 'analysis',
          ...(writes ? { 'Idempotency-Key': IDEMPOTENCY_KEY } : {}),
        },
        body,
      });
    },
  );

  it('registers every static Capability mapping and no arbitrary execution tool', async () => {
    const client = await connect(new RecordingDataHttpClient());
    const names = (await client.listTools()).tools.map(({ name }) => name);

    expect(names.filter((name) => name.startsWith('data_'))).toEqual(
      EXPECTED_DATA_TOOLS,
    );
    for (const forbidden of [
      'sql_execute',
      'cypher_execute',
      'opensearch_execute',
      'shell_execute',
      'filesystem_read_anywhere',
      'database_admin',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('routes bounded external metadata through HTTP without caller credentials or cached results', async () => {
    const http = new RecordingDataHttpClient();
    const client = await connect(http);
    const args = {
      sourceId: DATA_ITEM_ID,
      fromYear: 2021,
      toYear: 2025,
      limit: 2,
    };
    http.next = { status: 'EMPTY', items: [], total: 0 };
    await client.callTool({
      name: 'data_external_metadata_read',
      arguments: args,
    });
    await client.callTool({
      name: 'data_external_metadata_read',
      arguments: args,
    });
    expect(http.requests).toHaveLength(2);
    expect(http.requests[0]).toEqual({
      method: 'POST',
      path: `/external-sources/${DATA_ITEM_ID}/metadata/query`,
      headers: {
        'X-Wiser-Tenant-Id': TENANT_ID,
        'X-Wiser-Project-Id': PROJECT_ID,
        'X-Wiser-Purpose': 'analysis',
      },
      body: { fromYear: 2021, toYear: 2025, offset: 0, limit: 2 },
    });
    const denied = await client.callTool({
      name: 'data_external_metadata_read',
      arguments: { ...args, token: 'caller-controlled' },
    });
    expect(denied.isError).toBe(true);
    expect(http.requests).toHaveLength(2);
  });

  it('maps strict query and versioned command inputs only to the public HTTP API', async () => {
    const http = new RecordingDataHttpClient();
    const client = await connect(http);

    await client.callTool({
      name: 'data_catalog_search',
      arguments: { query: '永定河', first: 10 },
    });
    http.next = { features: [] };
    await client.callTool({
      name: 'data_geo_query',
      arguments: {
        geometry: {
          type: 'Point',
          coordinates: [116.2, 39.8],
          crs: 'EPSG:4490',
        },
        predicates: ['INTERSECTS'],
        versionId: VERSION_ID,
        first: 10,
      },
    });
    http.next = {
      operation: {
        operationId: 'a1000000-0000-4000-8000-000000000007',
        status: 'PENDING',
        resource: 'operation://a1000000-0000-4000-8000-000000000007',
      },
    };
    const submitted = await client.callTool({
      name: 'data_ingestion_submit',
      arguments: {
        ingestionId: INGESTION_ID,
        expectedVersion: 4,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });

    expect(http.requests).toEqual([
      {
        method: 'GET',
        path: '/catalog/data-items',
        headers: {
          'X-Wiser-Tenant-Id': TENANT_ID,
          'X-Wiser-Project-Id': PROJECT_ID,
          'X-Wiser-Purpose': 'analysis',
        },
        query: { query: '永定河', first: 10 },
      },
      {
        method: 'POST',
        path: '/geo/query',
        headers: {
          'X-Wiser-Tenant-Id': TENANT_ID,
          'X-Wiser-Project-Id': PROJECT_ID,
          'X-Wiser-Purpose': 'analysis',
        },
        body: {
          geometry: {
            type: 'Point',
            coordinates: [116.2, 39.8],
            crs: 'EPSG:4490',
          },
          predicates: ['INTERSECTS'],
          versionId: VERSION_ID,
          first: 10,
        },
      },
      {
        method: 'POST',
        path: `/ingestions/${INGESTION_ID}/submit`,
        headers: {
          'X-Wiser-Tenant-Id': TENANT_ID,
          'X-Wiser-Project-Id': PROJECT_ID,
          'X-Wiser-Purpose': 'analysis',
          'Idempotency-Key': IDEMPOTENCY_KEY,
          'If-Match': '"v4"',
        },
        body: {},
      },
    ]);
    expect(submitted.structuredContent).toMatchObject({
      ok: true,
      data: {
        operation: {
          status: 'PENDING',
          resource: 'operation://a1000000-0000-4000-8000-000000000007',
        },
      },
    });

    const before = http.requests.length;
    const rejected = await client.callTool({
      name: 'data_catalog_search',
      arguments: { query: 'x', first: 10, sql: 'select * from secrets' },
    });
    expect(rejected.isError).toBe(true);
    expect(http.requests).toHaveLength(before);
  });

  it('exposes only governed HTTP-backed resource templates', async () => {
    const http = new RecordingDataHttpClient();
    http.next = { versionId: VERSION_ID, dataItemId: DATA_ITEM_ID };
    const client = await connect(http);

    const templates = (await client.listResourceTemplates()).resourceTemplates;
    expect(templates.map(({ uriTemplate }) => uriTemplate)).toEqual([
      'data://items/{dataItemId}/versions/{versionId}',
      'evidence://fragments/{evidenceId}',
      'operation://{operationId}',
      'schema://capabilities/{capabilityId}/{version}',
      'stac://collections/{collectionId}/items/{itemId}',
    ]);

    const resource = await client.readResource({
      uri: `data://items/${DATA_ITEM_ID}/versions/${VERSION_ID}`,
    });
    expect(http.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/catalog/data-items/${DATA_ITEM_ID}/versions/${VERSION_ID}`,
    });
    const content = resource.contents[0];
    expect(
      content !== undefined && 'text' in content ? content.text : '',
    ).toContain(VERSION_ID);

    await client.readResource({
      uri: `evidence://fragments/${EVIDENCE_ID}`,
    });
    expect(http.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/evidence/fragments/${EVIDENCE_ID}`,
    });

    await client.readResource({
      uri: `stac://collections/${STAC_COLLECTION_ID}/items/${STAC_ITEM_ID}`,
    });
    expect(http.requests.at(-1)).toMatchObject({
      method: 'GET',
      path: `/stac/collections/${STAC_COLLECTION_ID}/items/${STAC_ITEM_ID}`,
    });
  });

  it('bounds Resource payloads independently from Tool responses', async () => {
    const http = new RecordingDataHttpClient();
    http.next = { content: 'x'.repeat(40_000) };
    const client = await connect(http);

    const resource = await client.readResource({
      uri: `evidence://fragments/${EVIDENCE_ID}`,
    });
    const content = resource.contents[0];
    const text = content !== undefined && 'text' in content ? content.text : '';
    expect(text).toContain('MCP_RESOURCE_TOO_LARGE');
    expect(text).not.toContain('xxxxx');
  });

  it('returns a safe MCP error without forwarding backend secrets', async () => {
    const http = new RecordingDataHttpClient();
    http.failure = new Error(
      'postgresql://admin:secret@data-postgres authority row dump',
    );
    const client = await connect(http);
    const result = await client.callTool({
      name: 'data_catalog_get',
      arguments: { dataItemId: DATA_ITEM_ID },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('postgresql');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('row dump');
  });

  it.each([
    [401, 'NOT_AUTHENTICATED'],
    [403, 'NOT_AUTHORIZED'],
  ] as const)(
    'preserves safe HTTP %i identity semantics without forwarding details',
    async (status, code) => {
      const http = new RecordingDataHttpClient();
      http.failure = new DataFoundationApiError('REQUEST_FAILED', status);
      const client = await connect(http);

      const result = await client.callTool({
        name: 'data_catalog_get',
        arguments: { dataItemId: DATA_ITEM_ID },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(JSON.stringify(result)).not.toContain('Bearer');
      expect(JSON.stringify(result)).not.toContain('details');
    },
  );

  it('projects an Operation Resource URI from nested or top-level operation output', async () => {
    const http = new RecordingDataHttpClient();
    const operationId = 'a1000000-0000-4000-8000-000000000009';
    http.next = { operation: { operationId, status: 'PENDING' } };
    const client = await connect(http);

    const nested = await client.callTool({
      name: 'data_ingestion_submit',
      arguments: {
        ingestionId: INGESTION_ID,
        expectedVersion: 4,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });
    expect(nested.structuredContent).toMatchObject({
      ok: true,
      resource: `operation://${operationId}`,
    });

    http.next = { operationId, status: 'PENDING' };
    const direct = await client.callTool({
      name: 'data_operation_get',
      arguments: { operationId },
    });
    expect(direct.structuredContent).toMatchObject({
      ok: true,
      resource: `operation://${operationId}`,
    });
  });
});

it.each(['create', 'list', 'open', 'revoke'] as const)(
  'preserves fixed candidate view %s HTTP semantics and destructive annotation',
  async (name) => {
    const http = new RecordingDataHttpClient();
    const client = await connect(http);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === `data_ingestion_candidate_view_${name}`,
    );
    expect(tool?.annotations?.readOnlyHint).toBe(
      name === 'list' || name === 'open',
    );
    expect(tool?.annotations?.destructiveHint).toBe(name === 'revoke');
    const reference = {
      kind: 'ingestion-candidate',
      ingestionId: INGESTION_ID,
      processingBatchId: VERSION_ID,
      reviewHash: 'a'.repeat(64),
    };
    const args =
      name === 'create'
        ? {
            title: 'Fixed pending source',
            references: [reference],
            viewSpec: { page: { kind: 'assets', reference } },
            idempotencyKey: IDEMPOTENCY_KEY,
          }
        : name === 'list'
          ? { first: 2 }
          : {
              viewId: VERSION_ID,
              ...(name === 'revoke' ? { idempotencyKey: IDEMPOTENCY_KEY } : {}),
            };
    http.next = { fixed: true };
    const result = await client.callTool({
      name: `data_ingestion_candidate_view_${name}`,
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    expect(http.requests[0]).toMatchObject({
      method: name === 'list' ? 'GET' : 'POST',
      path: `/ingestion-candidate-views${name === 'open' || name === 'revoke' ? `/${VERSION_ID}/${name}` : ''}`,
    });
    expect(JSON.stringify(http.requests)).not.toContain('versionId');
  },
);

it.each(['create', 'list', 'open'] as const)(
  'forwards independent candidate topic %s through bounded HTTP only',
  async (operation) => {
    const http = new RecordingDataHttpClient();
    const client = await connect(http);
    const tool = (await client.listTools()).tools.find(
      (item) => item.name === `data_ingestion_candidate_topic_${operation}`,
    );
    expect(tool?.annotations?.readOnlyHint).toBe(operation !== 'create');
    expect(tool?.annotations?.destructiveHint).toBe(false);
    const reference = {
      kind: 'ingestion-candidate',
      ingestionId: INGESTION_ID,
      processingBatchId: VERSION_ID,
      reviewHash: 'a'.repeat(64),
    };
    const args =
      operation === 'create'
        ? {
            title: '固定报告期专题',
            references: [reference],
            idempotencyKey: IDEMPOTENCY_KEY,
            viewSpec: {
              schemaVersion: 2,
              page: { kind: 'assets', reference, first: 2 },
              period: {
                windowMode: 'month',
                from: null,
                to: null,
                displayUnit: 'month',
                timeRole: 'REPORT_PERIOD',
                includeUndated: false,
              },
              topic: {
                question: '哪些报告月份可读？',
                regionIds: ['CHAObAI'],
                needIds: ['water-quality'],
                recordPins: [],
              },
              rulePins: [
                'projection',
                'readiness',
                'requirement',
                'impact',
              ].map((kind) => ({
                kind,
                ruleId: `${kind}-rule`,
                version: '1.0.0',
              })),
              dependencyPins: [
                {
                  kind: 'asset',
                  reference,
                  assetId: DATA_ITEM_ID,
                  sourceHash: 'b'.repeat(64),
                  parserVersion: 'parser/1.0.0',
                },
              ],
              relationPins: [],
            },
          }
        : operation === 'list'
          ? { first: 2 }
          : { viewId: VERSION_ID };
    http.next =
      operation === 'open'
        ? { status: 'UNAVAILABLE', viewId: VERSION_ID }
        : { fixed: true };
    const result = await client.callTool({
      name: `data_ingestion_candidate_topic_${operation}`,
      arguments: args,
    });
    expect(result.isError).not.toBe(true);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      method: operation === 'list' ? 'GET' : 'POST',
      path: `/ingestion-candidate-topics${operation === 'open' ? `/${VERSION_ID}/open` : ''}`,
    });
    if (operation === 'create')
      expect(http.requests[0]?.headers?.['Idempotency-Key']).toBe(
        IDEMPOTENCY_KEY,
      );
    const bad = await client.callTool({
      name: `data_ingestion_candidate_topic_${operation}`,
      arguments: { ...args, authority: 'verified' },
    });
    expect(bad.isError).toBe(true);
    expect(http.requests).toHaveLength(1);
  },
);
