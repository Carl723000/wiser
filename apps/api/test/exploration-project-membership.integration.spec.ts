import { PostgresExplorationExecutor } from '../src/data-foundation/exploration-runtime.js';
import { createExplorationSavedExecutors } from '../src/data-foundation/exploration-saved.js';

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  ImportRelationsOutputSchema,
  ExplorationResultSchema,
  CreateExplorationViewOutputSchema,
  OpenExplorationViewOutputSchema,
  RelationListOutputSchema,
} from '@wiser/data-contracts';
import { createKnowledgeRelationExecutors } from '../src/data-foundation/knowledge-relations-runtime.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'pins a 299-source, 2033-relation project through paging, refinement and saved reopening without exposing hidden sources',
  async () => {
    if (!process.env['DATA_TEST_DATABASE_URL'])
      throw new Error('DATA_TEST_DATABASE_URL is required');
    const pool = new Pool({
      connectionString: process.env['DATA_TEST_DATABASE_URL'],
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const client = await pool.connect();
    const tenant = randomUUID(),
      project = randomUUID(),
      actor = randomUUID(),
      item = randomUUID(),
      version = randomUUID();
    const role = `reconciliation_test_${actor.replaceAll('-', '')}`;
    const context: DataCapabilityExecutionContext = {
      principal: {
        actorId: actor,
        actorType: 'human',
        authenticationMethod: 'supabase_jwt',
        authUserId: actor,
        sessionId: randomUUID(),
      },
      authorization: {
        tenantId: tenant,
        projectId: project,
        roles: ['data-steward'],
        scopes: [
          'data.catalog.read',
          'data.query.execute',
          'data.ingestion.write',
          'data.publish',
        ],
        purpose: 'reconciliation-test',
        maxSecurityLevel: 'L1_INTERNAL',
        authzVersion: 1,
      },
      effectiveMaxSecurityLevel: 'L1_INTERNAL',
      traceId: 'a'.repeat(32),
      auditLevel: 'FULL',
      timeoutMs: 30000,
      signal: new AbortController().signal,
    };
    const transactionalPool = {
      async connect() {
        await client.query(`set local role ${role}`);
        return {
          async query(sql: string, values: readonly unknown[] = []) {
            if (sql.startsWith('begin'))
              return client.query('savepoint reconciliation');
            if (sql === 'commit')
              return client.query('release savepoint reconciliation');
            if (sql === 'rollback') {
              await client.query('rollback to savepoint reconciliation');
              return client.query('release savepoint reconciliation');
            }
            return client.query(sql, [...values]);
          },
          release() {},
        };
      },
      async end() {},
    };
    const executors = createKnowledgeRelationExecutors(transactionalPool);
    const call = (id: string, input: unknown, ctx = context) => {
      const executor = executors.find(
        (e) => e.id === `data.knowledge.relations.${id}`,
      );
      if (!executor) throw Error('Missing executor');
      return executor.execute(input, ctx);
    };
    const command = () => ({ ...context, idempotencyKey: randomUUID() });
    try {
      await client.query('begin');
      await client.query(`create role ${role} nologin nosuperuser nobypassrls`);
      await client.query(
        `grant usage on schema catalog,service,knowledge,security,event to ${role}`,
      );
      await client.query(
        `grant execute on all functions in schema security to ${role}`,
      );
      await client.query(
        `grant select on all tables in schema catalog,service,knowledge to ${role}`,
      );
      await client.query(
        `grant select,insert,update on security.audit_event,event.outbox_event,knowledge.assertion,knowledge.evidence_fragment,knowledge.review_record,knowledge.assertion_binding to ${role}`,
      );
      await client.query(
        `grant usage on all sequences in schema event to ${role}`,
      );
      await client.query(
        `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,citation_requirements,unit_definitions,missing_value_rules,anomaly_rules,generation_method,quality_grade,acceptance_status,publication_status,security_level,version,update_mode) values($1,$2,$3,$3,'Synthetic observations',array['water'],array['observed'],array['file-upload'],'RAW',array['analysis'],'Synthetic source','data.catalog.read','{}','[]','[]','[]','OBSERVED','C','PASSED','PUBLISHED','L1_INTERNAL',1,'SNAPSHOT')`,
        [item, tenant, project],
      );
      await client.query(
        `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at,published_at) values($1,$2,$3,$4,1,'{}',decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'RAW','OBSERVED','C','PASSED','PUBLISHED','L1_INTERNAL',now(),now())`,
        [version, tenant, project, item],
      );

      await client.query(
        `grant insert,update on service.relation_projection_checkpoint to ${role}`,
      );
      const asset = randomUUID();
      await client.query(
        `insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,raw_storage_key,lifecycle_state,security_level) values($1,$2,$3,decode(repeat('a',64),'hex'),20,$4,'RAW','L1_INTERNAL')`,
        [asset, tenant, project, `synthetic/${asset}`],
      );
      await client.query(
        `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,lifecycle_state,security_level,content_blob_id) values($1,$2,$3,$4,$5,decode(repeat('a',64),'hex'),'application/pdf',20,'RAW','L1_INTERNAL',$1)`,
        [asset, tenant, project, version, `synthetic/${asset}`],
      );
      const entity = (key: string, kind = 'MONITORING_POINT') => ({
        key,
        label: key,
        kind,
        externalId: `test:${key}`,
      });
      const relation = (
        subject: string,
        predicate: string,
        object: string,
      ) => ({
        subject: entity(subject),
        predicate,
        object: entity(object),
        qualifiers: {
          measure: null,
          unit: null,
          observedAt: '2025-06-01',
          missing: true,
          spatialScope: null,
          limitations: ['Source-local identity'],
          reportedConclusion: null,
        },
        generation: { method: 'SOURCE_TABLE', model: null },
        evidence: [
          {
            assetId: asset,
            sourceHash: 'a'.repeat(64),
            locator: 'PDF page 1, table row 1',
            excerpt: null,
            polarity: 'SUPPORTS',
          },
        ],
        supersedesId: null,
      });
      await client.query(
        `grant select,insert,update,delete on all tables in schema service to ${role}`,
      );
      await client.query(
        `grant execute on function service.valid_exploration_business_pins(jsonb) to ${role}`,
      );
      for (let n = 0; n < 298; n++) {
        const extraItem = randomUUID(),
          extraVersion = randomUUID();
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,citation_requirements,unit_definitions,missing_value_rules,anomaly_rules,generation_method,quality_grade,acceptance_status,publication_status,security_level,version,update_mode) values($1,$2,$3,$3,'Synthetic observations',array['water'],array['observed'],array['file-upload'],'RAW',array['analysis'],'Synthetic source','data.catalog.read','{}','[]','[]','[]','OBSERVED','C','PASSED','PUBLISHED','L1_INTERNAL',1,'SNAPSHOT')`,
          [extraItem, tenant, project],
        );
        await client.query(
          `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at,published_at) values($1,$2,$3,$4,1,'{}',decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'RAW','OBSERVED','C','PASSED','PUBLISHED','L1_INTERNAL',now(),now())`,
          [extraVersion, tenant, project, extraItem],
        );
      }
      const explore = new PostgresExplorationExecutor(transactionalPool);
      const saved = createExplorationSavedExecutors(transactionalPool, explore);
      const savedCall = async (id: string, body: unknown, ctx = context) => {
        const executor = saved.find((e) => e.id === id);
        if (!executor) throw new Error('Missing saved executor');
        return executor.execute(body, ctx);
      };
      for (let start = 0; start < 2033; start += 100) {
        const batch = Array.from(
          { length: Math.min(100, 2033 - start) },
          (_, i) =>
            relation(
              'point:' + String(start + i),
              'HAS_REPORTED_INDICATOR',
              'measurement:' + String(start + i),
            ),
        );
        const imported = ImportRelationsOutputSchema.parse(
          await call(
            'import',
            {
              dataItemId: item,
              versionId: version,
              mappingVersion: 'project.v1',
              candidates: batch,
            },
            command(),
          ),
        );
        expect(imported.createdCount).toBe(batch.length);
      }
      const businessQuery = {
        schemaVersion: 1,
        status: 'PENDING_REVIEW',
        revisionMode: 'all',
        filters: {
          kind: 'ALL',
          timeRole: 'ALL',
          from: null,
          to: null,
          includeUndated: true,
        },
      };
      const spec = { scope: 'project', businessQuery };
      const initial = ExplorationResultSchema.parse(
        await explore.execute({ spec, view: 'resources', first: 100 }, context),
      );
      expect(initial.totalCount).toBe(299);
      expect(initial.membership).toEqual({
        complete: true,
        versionCount: 299,
        assertionCount: 2033,
      });
      expect(initial.spec).not.toHaveProperty('versions');
      expect(initial.spec.businessQuery).not.toHaveProperty('assertionPins');
      const seen = new Set<string>();
      let after: string | undefined;
      do {
        const page = RelationListOutputSchema.parse(
          await call('list', {
            queryId: initial.queryId,
            status: 'PENDING_REVIEW',
            first: 100,
            ...(after ? { after } : {}),
          }),
        );
        expect(page.totalCount).toBe(2033);
        for (const row of page.items) {
          expect(seen.has(row.assertionId)).toBe(false);
          seen.add(row.assertionId);
        }
        after = page.nextCursor;
      } while (after);
      expect(seen.size).toBe(2033);
      // A later valid addition must not silently enter an existing saved/query scope.
      await call(
        'import',
        {
          dataItemId: item,
          versionId: version,
          mappingVersion: 'project.v1',
          candidates: [
            relation('later', 'HAS_REPORTED_INDICATOR', 'later-indicator'),
          ],
        },
        command(),
      );
      const refined = ExplorationResultSchema.parse(
        await explore.execute(
          { baseQueryId: initial.queryId, spec, view: 'resources' },
          context,
        ),
      );
      expect(refined.membership).toEqual(initial.membership);
      const created = CreateExplorationViewOutputSchema.parse(
        await savedCall(
          'data.explore.view.create',
          {
            queryId: initial.queryId,
            title: 'Synthetic project',
            viewSpec: {
              activeView: 'resources',
              requests: {
                resources: {
                  queryId: initial.queryId,
                  view: 'resources',
                  first: 25,
                },
              },
            },
          },
          command(),
        ),
      );
      const opened = OpenExplorationViewOutputSchema.parse(
        await savedCall('data.explore.view.open', {
          viewId: created.savedView.viewId,
        }),
      );
      expect(opened.result.membership).toEqual(initial.membership);
      expect(opened.result.queryId).not.toBe(initial.queryId);
      const fresh = ExplorationResultSchema.parse(
        await explore.execute({ spec, view: 'resources' }, context),
      );
      expect(fresh.membership?.assertionCount).toBe(2034);
      const stranger = {
        ...context,
        principal: { ...context.principal, actorId: randomUUID() },
      };
      await expect(
        explore.execute(
          { queryId: initial.queryId, view: 'resources' },
          stranger,
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await client.query('reset role');
      await client.query(
        "update catalog.data_item set publication_status='WITHDRAWN' where data_item_id=$1",
        [item],
      );
      await expect(
        explore.execute(
          { queryId: initial.queryId, view: 'resources' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        call('list', { queryId: initial.queryId, status: 'PENDING_REVIEW' }),
      ).rejects.toThrow();
    } finally {
      await client.query('rollback');
      client.release();
      await pool.end();
    }
  },
  120000,
);
