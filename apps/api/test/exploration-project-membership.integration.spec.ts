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
        evidenceAsset = asset,
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
            assetId: evidenceAsset,
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
      const sources = [{ item, version, asset }];
      for (let n = 0; n < 299; n++) {
        const extraItem = randomUUID(),
          extraVersion = randomUUID();
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,citation_requirements,unit_definitions,missing_value_rules,anomaly_rules,generation_method,quality_grade,acceptance_status,publication_status,security_level,version,update_mode) values($1,$2,$3,$3,'Synthetic observations',array['water'],array['observed'],array['file-upload'],'RAW',array['analysis'],'Synthetic source','data.catalog.read','{}','[]','[]','[]','OBSERVED','C','PASSED','PUBLISHED',$4,1,'SNAPSHOT')`,
          [
            extraItem,
            tenant,
            project,
            n === 298 ? 'L2_RESTRICTED' : 'L1_INTERNAL',
          ],
        );
        await client.query(
          `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at,published_at) values($1,$2,$3,$4,1,'{}',decode(repeat('a',64),'hex'),decode(repeat('b',64),'hex'),'RAW','OBSERVED','C','PASSED','PUBLISHED',$5,now(),now())`,
          [
            extraVersion,
            tenant,
            project,
            extraItem,
            n === 298 ? 'L2_RESTRICTED' : 'L1_INTERNAL',
          ],
        );
        if (n < 298) {
          const extraAsset = randomUUID();
          await client.query(
            `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,lifecycle_state,security_level,content_blob_id) values($1,$2,$3,$4,$5,decode(repeat('a',64),'hex'),'application/pdf',20,'RAW','L1_INTERNAL',$6)`,
            [
              extraAsset,
              tenant,
              project,
              extraVersion,
              `synthetic/${extraAsset}`,
              asset,
            ],
          );
          sources.push({
            item: extraItem,
            version: extraVersion,
            asset: extraAsset,
          });
        }
      }
      const explore = new PostgresExplorationExecutor(transactionalPool);
      const saved = createExplorationSavedExecutors(transactionalPool, explore);
      const savedCall = async (id: string, body: unknown, ctx = context) => {
        const executor = saved.find((e) => e.id === id);
        if (!executor) throw new Error('Missing saved executor');
        return executor.execute(body, ctx);
      };
      const startedAt = performance.now();
      const checkpoint = (phase: string) =>
        console.info(
          'project-membership-fixture',
          phase,
          Math.round(performance.now() - startedAt),
        );
      // Exercise membership across sources; import performance of thousands of
      // distinct entities in one source is a separate measured ingestion concern.
      for (let start = 0; start < 2033; start += 7) {
        const source = sources[Math.floor(start / 7)]!;
        const batch = Array.from(
          { length: Math.min(7, 2033 - start) },
          (_, i) =>
            relation(
              'point:' + String(start + i),
              'HAS_REPORTED_INDICATOR',
              'measurement:' + String(start + i),
              source.asset,
            ),
        );
        const imported = ImportRelationsOutputSchema.parse(
          await call(
            'import',
            {
              dataItemId: source.item,
              versionId: source.version,
              mappingVersion: 'project.v1',
              candidates: batch,
            },
            command(),
          ),
        );
        expect(imported.createdCount).toBe(batch.length);
        if (start % 500 === 0) checkpoint(`imported-${start + batch.length}`);
      }
      checkpoint('import-complete');
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
      checkpoint('query-created');
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
        checkpoint(`page-${seen.size}`);
        expect(page.totalCount).toBe(2033);
        for (const row of page.items) {
          expect(seen.has(row.assertionId)).toBe(false);
          seen.add(row.assertionId);
        }
        after = page.nextCursor;
      } while (after);
      expect(seen.size).toBe(2033);
      const sourceIds = new Set(initial.resources.map((row) => row.versionId));
      let resourceAfter = initial.nextCursor;
      while (resourceAfter) {
        const page = ExplorationResultSchema.parse(
          await explore.execute(
            {
              queryId: initial.queryId,
              view: 'resources',
              first: 100,
              after: resourceAfter,
            },
            context,
          ),
        );
        expect(page.membership).toEqual(initial.membership);
        for (const row of page.resources) {
          expect(sourceIds.has(row.versionId)).toBe(false);
          sourceIds.add(row.versionId);
        }
        resourceAfter = page.nextCursor;
      }
      expect(sourceIds.size).toBe(299);
      const future = ExplorationResultSchema.parse(
        await explore.execute(
          {
            baseQueryId: initial.queryId,
            spec: {
              ...spec,
              businessQuery: {
                ...businessQuery,
                filters: {
                  ...businessQuery.filters,
                  from: '2099-01-01',
                  to: '2099-12-31',
                  includeUndated: false,
                },
              },
            },
            view: 'resources',
          },
          context,
        ),
      );
      expect(future.membership).toEqual(initial.membership);
      const futurePage = RelationListOutputSchema.parse(
        await call('list', {
          queryId: future.queryId,
          status: 'PENDING_REVIEW',
        }),
      );
      expect(futurePage.totalCount).toBe(0);
      expect(futurePage.items).toEqual([]);
      await expect(
        explore.execute(
          {
            baseQueryId: initial.queryId,
            spec: {
              ...spec,
              businessQuery: { ...businessQuery, status: 'APPROVED' },
            },
            view: 'resources',
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

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
      checkpoint('refined');
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
      // Synthetic authority states only, inside the rollback-only isolated fixture.
      const reviewer = {
        ...command(),
        principal: { ...context.principal, actorId: randomUUID() },
      };
      const changed = [...seen].slice(0, 3);
      for (const [index, status] of [
        'APPROVED',
        'REJECTED',
        'CORRECTION_REQUIRED',
      ].entries())
        await call(
          'review',
          {
            assertionId: changed[index],
            expectedVersion: 1,
            decision: status,
            rationale: 'Synthetic isolated review',
          },
          { ...reviewer, idempotencyKey: randomUUID() },
        );
      const mixedSpec = {
        ...spec,
        businessQuery: {
          ...businessQuery,
          schemaVersion: 2,
          status: 'APPROVED_AND_PENDING',
        },
      };
      const mixed = ExplorationResultSchema.parse(
        await explore.execute({ spec: mixedSpec, view: 'resources' }, context),
      );
      expect(mixed.membership).toEqual({
        complete: true,
        versionCount: 299,
        assertionCount: 2032,
      });
      const mixedRows = [];
      let mixedCursor: string | undefined;
      do {
        const page = RelationListOutputSchema.parse(
          await call('list', {
            queryId: mixed.queryId,
            status: 'APPROVED_AND_PENDING',
            first: 100,
            ...(mixedCursor ? { after: mixedCursor } : {}),
          }),
        );
        expect(page.totalCount).toBe(2032);
        mixedRows.push(...page.items);
        mixedCursor = page.nextCursor;
      } while (mixedCursor);
      expect(new Set(mixedRows.map((r) => r.status))).toEqual(
        new Set(['APPROVED', 'PENDING_REVIEW']),
      );
      expect(mixedRows.find((r) => r.assertionId === changed[0])?.status).toBe(
        'APPROVED',
      );
      expect(
        mixedRows.some((r) => changed.slice(1).includes(r.assertionId)),
      ).toBe(false);
      expect(new Set(mixedRows.map((r) => r.assertionId)).size).toBe(2032);
      await expect(
        call('list', { queryId: mixed.queryId, status: 'APPROVED' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        explore.execute(
          { baseQueryId: mixed.queryId, spec, view: 'resources' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const mixedSaved = CreateExplorationViewOutputSchema.parse(
        await savedCall(
          'data.explore.view.create',
          {
            queryId: mixed.queryId,
            title: 'Mixed synthetic scope',
            viewSpec: {
              activeView: 'resources',
              requests: {
                resources: {
                  queryId: mixed.queryId,
                  view: 'resources',
                  first: 25,
                },
              },
            },
          },
          command(),
        ),
      );
      const mixedOpened = OpenExplorationViewOutputSchema.parse(
        await savedCall('data.explore.view.open', {
          viewId: mixedSaved.savedView.viewId,
        }),
      );
      expect(mixedOpened.result.membership).toEqual(mixed.membership);
      expect(mixedOpened.result.spec.businessQuery?.status).toBe(
        'APPROVED_AND_PENDING',
      );
      const ordinary = ExplorationResultSchema.parse(
        await explore.execute({ spec: {}, view: 'resources' }, context),
      );
      await expect(
        call('list', {
          queryId: ordinary.queryId,
          status: 'APPROVED_AND_PENDING',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        call(
          'list',
          { queryId: mixed.queryId, status: 'APPROVED_AND_PENDING' },
          {
            ...context,
            principal: { ...context.principal, actorId: randomUUID() },
          },
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Even a review that stays inside the two-state set invalidates old membership.
      await call(
        'review',
        {
          assertionId: changed[0],
          expectedVersion: 2,
          decision: 'APPROVED',
          rationale: 'Synthetic repeated review invalidates old snapshot',
        },
        { ...reviewer, idempotencyKey: randomUUID() },
      );
      await expect(
        call('list', {
          queryId: mixed.queryId,
          status: 'APPROVED_AND_PENDING',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
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
