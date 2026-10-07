import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CreateIngestionCandidateTopicInput } from '@wiser/data-contracts';
import * as saved from '../src/data-foundation/ingestion-candidate-saved.js';
import { readCandidateRelationPinAuthorities } from '../src/data-foundation/ingestion-candidate-relations.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import type { QueryAdapterPgClient } from '../src/data-foundation/query-adapters.js';
import type { CandidateTopicPinAuthorities } from '../src/data-foundation/ingestion-candidate-topic-pins.js';
import { setCandidateReadAuthority } from '../src/data-foundation/candidate-read-authority.js';
import {
  createCandidateTopicHost,
  CANDIDATE_TOPIC_ENGINEERING_ADOPTION,
} from '../src/data-foundation/ingestion-candidate-topic-host.js';

const uuid = (n: number) =>
  `6abcdef0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId: uuid(1),
  processingBatchId: uuid(2),
  reviewHash: 'a'.repeat(64),
};
const rules = ['projection', 'readiness', 'requirement', 'impact'].map(
  (kind) => ({ kind, ruleId: `${kind}-fixture`, version: '1.0.0' }),
);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
const hash = (domain: string, value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical({ domain, ...(value as object) })))
    .digest('hex');
const identity = { reference, assetId: uuid(3), recordId: uuid(4) };
const recordMaterial = {
  ...identity,
  recordIndex: 1,
  sourceId: 'source-row',
  valuesJson: '{"a":1,"b":[2,null]}',
};
const geometryMaterial = {
  ...identity,
  sourceCrs: 'EPSG:4326',
  geometry: { type: 'Point', coordinates: [116.5, 40.5] },
};
const recordHash = hash('wiser.candidate-topic.record.v1', recordMaterial);
const geometryHash = hash(
  'wiser.candidate-topic.geometry.v1',
  geometryMaterial,
);
const input = (): CreateIngestionCandidateTopicInput =>
  structuredClone({
    title: 'Fixed synthetic candidate topic',
    visibility: 'private',
    references: [reference],
    viewSpec: {
      schemaVersion: 2,
      page: { kind: 'records', reference, assetId: uuid(3), first: 2 },
      period: {
        windowMode: 'month',
        from: '2026-01',
        to: '2026-02',
        timeRole: 'REPORT_PERIOD',
        displayUnit: 'month',
        includeUndated: false,
      },
      topic: {
        question: 'Synthetic fixed selection',
        regionIds: ['fixture-region'],
        needIds: ['fixture-need'],
        recordPins: [identity],
      },
      rulePins:
        rules as CreateIngestionCandidateTopicInput['viewSpec']['rulePins'],
      dependencyPins: [
        {
          kind: 'asset',
          reference,
          assetId: uuid(3),
          sourceHash: 'b'.repeat(64),
          parserVersion: 'fixture-parser/1.0.0',
        },
        {
          kind: 'geometry',
          ...identity,
          sourceHash: 'b'.repeat(64),
          parserVersion: 'fixture-parser/1.0.0',
          recordHash,
          geometryHash,
        },
      ],
      relationPins: [],
    },
  });

it('uses the production host for actual whole-record pins and retains the post-provider manifest recheck', async () => {
  const source = new Source();
  const value = input();
  value.viewSpec.topic.regionIds = ['bth'];
  value.viewSpec.topic.needIds = ['K5-001'];
  value.viewSpec.rulePins = [
    {
      kind: 'projection',
      ruleId: 'beijing-monthly-docx-c3',
      version: 'beijing-monthly-docx-c3/2.0.0',
    },
    {
      kind: 'readiness',
      ruleId: 'wiser.project-readiness',
      version: 'wiser.project-readiness.v3',
    },
    {
      kind: 'requirement',
      ruleId: 'wiser.candidate-topic.requirement-inspection',
      version: `sha256:${CANDIDATE_TOPIC_ENGINEERING_ADOPTION.requirement.sha256}`,
    },
    {
      kind: 'impact',
      ruleId: 'wiser.candidate-topic.version-impact',
      version: `sha256:${CANDIDATE_TOPIC_ENGINEERING_ADOPTION.impact.sha256}`,
    },
  ];
  const host = createCandidateTopicHost({
    profile: 'goal101-engineering-inspection/1',
    tenantId: uuid(20),
    projectId: uuid(21),
    purpose: 'candidate-review',
  })!;
  await expect(
    validator()(source.client, value, context(), host),
  ).resolves.toEqual(value);
  const revoked: CandidateTopicPinAuthorities = {
    ...host,
    async loadRules(...args) {
      const result = await host.loadRules(...args);
      source.visible = false;
      return result;
    },
  };
  await expect(
    validator()(source.client, value, context(), revoked),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
const context = (): DataCapabilityExecutionContext => ({
  principal: {
    actorId: uuid(10),
    actorType: 'human',
    authenticationMethod: 'supabase_jwt',
    authUserId: uuid(10),
    sessionId: uuid(11),
  },
  authorization: {
    tenantId: uuid(20),
    projectId: uuid(21),
    purpose: 'candidate-review',
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    maxSecurityLevel: 'L0_PUBLIC',
    authzVersion: 1,
  },
  effectiveMaxSecurityLevel: 'L0_PUBLIC',
  traceId: 'c'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30_000,
  signal: new AbortController().signal,
});
type Authorities = CandidateTopicPinAuthorities;
type Validator = (
  client: QueryAdapterPgClient,
  value: unknown,
  current: DataCapabilityExecutionContext,
  authorities?: Authorities,
) => Promise<CreateIngestionCandidateTopicInput>;
function validator(): Validator {
  return saved.validateIngestionCandidateTopicPins;
}
class Source {
  visible = true;
  row: Record<string, unknown> = {
    ingestion_id: reference.ingestionId,
    processing_batch_id: reference.processingBatchId,
    review_hash: reference.reviewHash,
    tenant_id: uuid(20),
    project_id: uuid(21),
    asset_id: uuid(3),
    record_id: uuid(4),
    source_hash: 'b'.repeat(64),
    parser_version: 'fixture-parser/1.0.0',
    record_index: 1,
    source_id: 'source-row',
    record_values: { b: [2, null], a: 1 },
    source_crs: 'EPSG:4326',
    geometry: JSON.stringify(geometryMaterial.geometry),
    geometry_bytes: 47,
  };
  statements: string[] = [];
  fixedSelections: unknown[] = [];
  relationRows: Record<string, unknown>[] = [];
  client: QueryAdapterPgClient = {
    release() {},
    query: (sql, values = []) =>
      Promise.resolve().then(() => {
        this.statements.push(sql);
        if (sql.includes('data.ingestion.candidate.scope'))
          this.fixedSelections.push(JSON.parse(String(values[6])));
        if (sql.includes('candidate.relations.fixed-pins'))
          return { rows: this.relationRows };
        if (sql.includes('candidate.saved.references'))
          return {
            rows: this.visible
              ? (JSON.parse(String(values[0])) as (typeof reference)[]).map(
                  (ref) => ({
                    ingestion_id: ref.ingestionId,
                    processing_batch_id: ref.processingBatchId,
                    review_hash: ref.reviewHash,
                    submitted_by_actor_id: uuid(10),
                    submitted_actor_type: 'human',
                    submitted_delegator_actor_id: null,
                  }),
                )
              : [],
          };
        if (sql.includes('candidate.saved.anchor'))
          return {
            rows: this.visible
              ? [{ ordinal: 1, record_index: 1, has_geometry: true }]
              : [],
          };
        if (sql.includes('candidate.topic.material'))
          return {
            rows: this.visible
              ? [
                  {
                    ...this.row,
                    record_values_json:
                      this.row.record_values_json ??
                      JSON.stringify(this.row.record_values),
                    ...(values[3] === null ? { record_id: null } : {}),
                  },
                ]
              : [],
          };
        return { rows: [] };
      }),
  };
}
const authorities = (): Authorities => ({
  loadRules: () => Promise.resolve(structuredClone(input().viewSpec.rulePins)),
});

describe('candidate topic server pin validation (synthetic scoped storage)', () => {
  it('installs the complete parsed fixed reference selection before validating a topic', async () => {
    const source = new Source(),
      value = input();
    value.references.push({
      ...reference,
      ingestionId: uuid(31),
      processingBatchId: uuid(32),
      reviewHash: 'd'.repeat(64),
    });
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).resolves.toEqual(value);
    expect(source.fixedSelections).not.toHaveLength(0);
    for (const selection of source.fixedSelections)
      expect(selection).toEqual(value.references);
  });
  it('passes the same complete fixed selection through the real internal relation provider without a nested transaction', async () => {
    const source = new Source(),
      value = input();
    value.references.push({
      ...reference,
      ingestionId: uuid(31),
      processingBatchId: uuid(32),
      reviewHash: 'd'.repeat(64),
    });
    const pin = { relationId: uuid(40), revision: 1, decisionVersion: 0 };
    value.viewSpec.relationPins = [pin];
    source.relationRows = [
      { ...pin, dependencies: [{ ...identity, sourceHash: 'b'.repeat(64) }] },
    ];
    const provider = {
      ...authorities(),
      loadRelations: readCandidateRelationPinAuthorities,
    };
    await expect(
      validator()(source.client, value, context(), provider),
    ).resolves.toEqual(value);
    expect(source.fixedSelections.length).toBeGreaterThanOrEqual(2);
    for (const selection of source.fixedSelections)
      expect(selection).toEqual(value.references);
    expect(
      source.statements.every((sql) => !/^(begin|commit|rollback)/i.test(sql)),
    ).toBe(true);
  });

  it('restores the original parsed selection for the final manifest check after an internal provider clears its own scope', async () => {
    const source = new Source(),
      value = input(),
      provider = authorities();
    provider.loadRules = async (client, current, _selection, pins) => {
      await setCandidateReadAuthority(client, current, []);
      return pins;
    };
    await expect(
      validator()(source.client, value, context(), provider),
    ).resolves.toEqual(value);
    expect(source.fixedSelections).toContainEqual([]);
    expect(source.fixedSelections.at(-1)).toEqual(value.references);
  });
  it('locates the fixed adopted rule set without replacing it with a newly available set', async () => {
    const source = new Source();
    const trusted = authorities();
    const available = [
      input().viewSpec.rulePins,
      input().viewSpec.rulePins.map((pin) => ({ ...pin, version: '2.0.0' })),
    ];
    trusted.loadRules = (_client, _current, _selection, requested) => {
      expect(requested).toEqual(available[0]);
      return Promise.resolve(available[0]!);
    };
    await expect(
      validator()(source.client, input(), context(), trusted),
    ).resolves.toEqual(input());
  });
  it('checks actual bounded candidate material and a host-selected complete rule set', async () => {
    const source = new Source();
    const current = context();
    const trusted = authorities();
    trusted.loadRules = (client, actual, selection) => {
      expect(client).toBe(source.client);
      expect(actual).toBe(current);
      expect(selection.regionIds).toEqual(['fixture-region']);
      return Promise.resolve(input().viewSpec.rulePins);
    };
    expect(await validator()(source.client, input(), current, trusted)).toEqual(
      input(),
    );
    const sql = source.statements.find((statement) =>
      statement.includes('candidate.topic.material'),
    )!;
    expect(sql).toContain('batch.review_hash');
    expect(sql).toContain('batch.tenant_id');
    expect(sql).toContain('batch.project_id');
    expect(sql).toContain('ST_AsGeoJSON(record.geom,15,0)');
    expect(
      source.statements.filter((statement) =>
        statement.includes('candidate.saved.references'),
      ),
    ).toHaveLength(2);
  });
  it.each([
    'source_hash',
    'parser_version',
    'review_hash',
    'ingestion_id',
    'processing_batch_id',
    'asset_id',
    'record_id',
    'tenant_id',
    'project_id',
  ])('rejects drift in actual %s', async (field) => {
    const source = new Source();
    source.row[field] = field.includes('hash')
      ? 'd'.repeat(64)
      : field === 'parser_version'
        ? 'fixture-parser/2.0.0'
        : uuid(99);
    await expect(
      validator()(source.client, input(), context(), authorities()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it.each(['record', 'geometry', 'sourceCrs', 'geometryAbsent'])(
    'rejects actual %s drift without substituting another fingerprint',
    async (kind) => {
      const source = new Source();
      if (kind === 'record') source.row.record_values = { a: 2, b: [2, null] };
      else if (kind === 'geometry')
        source.row.geometry = JSON.stringify({
          type: 'Point',
          coordinates: [116.6, 40.5],
        });
      else if (kind === 'sourceCrs') source.row.source_crs = 'EPSG:3857';
      else source.row.geometry = null;
      await expect(
        validator()(source.client, input(), context(), authorities()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it('canonicalizes object keys while preserving array order, null and full geometry', async () => {
    const source = new Source();
    source.row.record_values = { a: 1, b: [2, null] };
    await expect(
      validator()(source.client, input(), context(), authorities()),
    ).resolves.toEqual(input());
    source.row.record_values = { a: 1, b: [null, 2] };
    await expect(
      validator()(source.client, input(), context(), authorities()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('normalizes candidate UUID case in fingerprints and precise row binding', async () => {
    const source = new Source();
    const value = input();
    value.viewSpec.topic.recordPins[0]!.reference.ingestionId =
      reference.ingestionId.toUpperCase();
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).resolves.toEqual(value);
  });
  it('fails closed without the trusted current rule provider', async () => {
    const source = new Source();
    await expect(
      validator()(source.client, input(), context()),
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
  });
  it.each(['changed', 'missing', 'extra'])(
    'rejects %s adopted rule sets rather than accepting client-declared versions',
    async (kind) => {
      const source = new Source();
      const trusted = authorities();
      trusted.loadRules = () => {
        const result = structuredClone(input().viewSpec.rulePins);
        if (kind === 'changed') result[0]!.version = '2.0.0';
        else if (kind === 'missing') result.pop();
        else
          result.push({
            kind: 'impact',
            ruleId: 'another-adopted-rule',
            version: '1.0.0',
          });
        return Promise.resolve(result);
      };
      await expect(
        validator()(source.client, input(), context(), trusted),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it('requires an explicit source object mapping and never aliases source_id', async () => {
    const source = new Source();
    const value = input();
    value.viewSpec.topic.recordPins[0]!.sourceObjectKey = 'source-row';
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    const trusted = authorities();
    trusted.sourceObjectKey = () => Promise.resolve(null);
    await expect(
      validator()(source.client, value, context(), trusted),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    trusted.sourceObjectKey = () => Promise.resolve('source-row');
    await expect(
      validator()(source.client, value, context(), trusted),
    ).resolves.toEqual(value);
  });
  it('requires a genuine candidate relation provider and checks revision, decision and source dependencies', async () => {
    const source = new Source();
    const value = input();
    const pin = { relationId: uuid(50), revision: 1, decisionVersion: 0 };
    value.viewSpec.relationPins = [pin];
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).rejects.toMatchObject({ code: 'EXECUTION_FAILED' });
    const trusted = authorities();
    trusted.loadRelations = () =>
      Promise.resolve([
        { ...pin, dependencies: [{ ...identity, sourceHash: 'b'.repeat(64) }] },
      ]);
    await expect(
      validator()(source.client, value, context(), trusted),
    ).resolves.toEqual(value);
    for (const row of [
      {
        ...pin,
        revision: 2,
        dependencies: [{ ...identity, sourceHash: 'b'.repeat(64) }],
      },
      {
        ...pin,
        decisionVersion: 1,
        dependencies: [{ ...identity, sourceHash: 'b'.repeat(64) }],
      },
      {
        ...pin,
        dependencies: [
          { ...identity, recordId: uuid(99), sourceHash: 'b'.repeat(64) },
        ],
      },
      { ...pin, dependencies: [] },
    ]) {
      trusted.loadRelations = () => Promise.resolve([row]);
      await expect(
        validator()(source.client, value, context(), trusted),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    trusted.loadRelations = () => Promise.resolve([]);
    await expect(
      validator()(source.client, value, context(), trusted),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it.each(['revoke', 'abort', 'expiry'])(
    'rechecks current authority after a %s during rule loading',
    async (kind) => {
      const source = new Source();
      const controller = new AbortController();
      const current = { ...context(), signal: controller.signal };
      const trusted = authorities();
      trusted.loadRules = () => {
        if (kind === 'revoke') source.visible = false;
        else if (kind === 'abort') controller.abort();
        else current.principal.expiresAt = '2000-01-01T00:00:00Z';
        return Promise.resolve(input().viewSpec.rulePins);
      };
      await expect(
        validator()(source.client, input(), current, trusted),
      ).rejects.toMatchObject({
        code:
          kind === 'revoke'
            ? 'NOT_FOUND'
            : kind === 'abort'
              ? 'CAPABILITY_TIMEOUT'
              : 'FORBIDDEN',
      });
    },
  );
  it.each(['recordTooLarge', 'geometryTooLarge', 'invalidJson'])(
    'fails closed for %s actual content',
    async (kind) => {
      const source = new Source();
      if (kind === 'recordTooLarge')
        source.row.record_values = { text: 'x'.repeat(262145) };
      else if (kind === 'geometryTooLarge')
        source.row.geometry_bytes = 3_145_729;
      else source.row.record_values_json = '{"value":NaN}';
      await expect(
        validator()(source.client, input(), context(), authorities()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it('preserves PostgreSQL JSON numeric tokens beyond JavaScript integer precision', async () => {
    const source = new Source();
    const value = input();
    source.row.record_values_json = '{"large":9007199254740992}';
    const expected = hash('wiser.candidate-topic.record.v1', {
      ...recordMaterial,
      valuesJson: '{"large":9007199254740992}',
    });
    const pin = value.viewSpec.dependencyPins[1]!;
    if (pin.kind !== 'asset') pin.recordHash = expected;
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).resolves.toEqual(value);
    source.row.record_values_json = '{"large":9007199254740993}';
    await expect(
      validator()(source.client, value, context(), authorities()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not reinterpret strict versionless v1 or unknown versions as topic v2', async () => {
    const source = new Source();
    const value = input();
    const { schemaVersion: _version, ...versionless } = value.viewSpec;
    await expect(
      validator()(
        source.client,
        { ...value, viewSpec: versionless },
        context(),
        authorities(),
      ),
    ).rejects.toBeDefined();
    await expect(
      validator()(
        source.client,
        { ...value, viewSpec: { ...value.viewSpec, schemaVersion: 3 } },
        context(),
        authorities(),
      ),
    ).rejects.toBeDefined();
    expect(source.statements).toHaveLength(0);
  });
});
