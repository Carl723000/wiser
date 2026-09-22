import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';
import { PostgresExplorationExecutor } from '../src/data-foundation/exploration-runtime.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import { ExplorationResultSchema } from '@wiser/data-contracts';

it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'enforces live resource changes in real catalog and exploration execution, including old query and export replay',
  async () => {
    const url = process.env['DATA_TEST_DATABASE_URL'];
    if (!url) throw Error('DATA_TEST_DATABASE_URL is required');
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    const tenant = randomUUID(),
      project = randomUUID(),
      actor = randomUUID();
    const role = `resource_api_${randomUUID().replaceAll('-', '')}`;
    const sources = Array.from({ length: 2 }, () => ({
      dataItemId: randomUUID(),
      versionId: randomUUID(),
    }));
    const first = sources[0]!,
      second = sources[1]!;
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
        roles: ['data-reader'],
        scopes: ['data.catalog.read', 'data.query.execute'],
        purpose: 'resource-test',
        maxSecurityLevel: 'L1_INTERNAL',
        authzVersion: 1,
        resourceAccess: {
          revision: 1,
          fingerprint: 'a'.repeat(64),
          scope: {
            mode: 'managed',
            validUntil: '2099-01-01T00:00:00Z',
            permissions: {
              'content.read': [{ kind: 'version', ...first }],
              'source.discover': [],
              'original.read': [],
              'result.export': [],
              'external.directory': [],
            },
          },
        },
      },
      effectiveMaxSecurityLevel: 'L1_INTERNAL',
      traceId: 'a'.repeat(32),
      auditLevel: 'STANDARD',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };
    // Real statements under a non-bypass role; nested transaction boundaries stay
    // within the outer disposable fixture and preserve production rollback behavior.
    const runtimePool = {
      connect: () =>
        Promise.resolve({
          query: async (sql: string, values?: readonly unknown[]) => {
            if (/^begin\b/i.test(sql)) {
              await client.query('savepoint resource_api');
              return { rows: [] };
            }
            if (/^commit\b/i.test(sql)) {
              await client.query('release savepoint resource_api');
              return { rows: [] };
            }
            if (/^rollback\b/i.test(sql)) {
              await client.query('rollback to savepoint resource_api');
              return { rows: [] };
            }
            return client.query<Record<string, unknown>>(
              sql,
              values ? [...values] : undefined,
            );
          },
          release() {},
        }),
      end: () => Promise.resolve(),
    };
    try {
      await client.query('begin');
      await client.query(`create role ${role} nologin nosuperuser nobypassrls`);
      await client.query(`grant ${role} to current_user`);
      await client.query(
        `grant usage on schema catalog,service,security,knowledge to ${role}`,
      );
      await client.query(
        `grant select on all tables in schema catalog,service,knowledge to ${role}`,
      );
      await client.query(
        `grant insert,delete on service.exploration_snapshot to ${role}`,
      );
      await client.query(
        `grant execute on all functions in schema security,service to ${role}`,
      );
      for (const s of sources) {
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode) values($1,$2,$3,$3,'Synthetic resource',array['water-quality'],array['observed'],array['official'],'RAW',array['research'],'Synthetic provider','test','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL','SNAPSHOT')`,
          [s.dataItemId, tenant, project],
        );
        await client.query(
          `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at) values($1,$2,$3,$4,1,'{}',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),'RAW','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL',now())`,
          [s.versionId, tenant, project, s.dataItemId],
        );
      }
      await client.query(`set local role ${role}`);
      const catalog = createPostgresDataReadRuntime(runtimePool).executors.find(
        (e) => e.id === 'data.catalog.search',
      )!;
      await expect(
        catalog.execute(
          { query: 'Synthetic', includeTotal: true, first: 10 },
          context,
        ),
      ).resolves.toMatchObject({
        totalCount: 1,
        items: [{ dataItemId: first.dataItemId }],
      });
      const exploration = new PostgresExplorationExecutor(runtimePool);
      const result = ExplorationResultSchema.parse(
        await exploration.execute(
          { spec: {}, view: 'resources', first: 10 },
          context,
        ),
      );
      expect(result.totalCount).toBe(1);
      expect(result.resources.map((r) => r.versionId)).toEqual([
        first.versionId,
      ]);
      await expect(
        exploration.execute(
          { queryId: result.queryId, view: 'resources', first: 10 },
          { ...context, resourceReadAction: 'result.export' },
        ),
        // Existing immutable-query contract rejects any inaccessible pinned member.
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const wider = structuredClone(context.authorization);
      if (wider.resourceAccess?.scope.mode !== 'managed')
        throw Error('Invalid test context');
      wider.resourceAccess.scope.permissions['content.read'] = sources.map(
        (source) => ({ kind: 'version', ...source }),
      );
      wider.resourceAccess.fingerprint = 'c'.repeat(64);
      const page = z
        .object({ nextCursor: z.string() })
        .parse(
          await catalog.execute(
            { query: 'Synthetic', includeTotal: true, first: 1 },
            { ...context, authorization: wider },
          ),
        );
      await expect(
        catalog.execute(
          {
            query: 'Synthetic',
            includeTotal: true,
            first: 1,
            after: page.nextCursor,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_DATA_CURSOR' });
      const changed = structuredClone(context.authorization);
      if (changed.resourceAccess?.scope.mode !== 'managed')
        throw Error('Invalid test context');
      changed.resourceAccess.scope.permissions['content.read'] = [
        { kind: 'version', ...second },
      ];
      changed.resourceAccess.fingerprint = 'b'.repeat(64);
      changed.resourceAccess.revision = 2;
      await expect(
        catalog.execute(
          { query: 'Synthetic', includeTotal: true, first: 10 },
          { ...context, authorization: changed },
        ),
      ).resolves.toMatchObject({
        totalCount: 1,
        items: [{ dataItemId: second.dataItemId }],
      });
      await expect(
        exploration.execute(
          { queryId: result.queryId, view: 'resources', first: 10 },
          { ...context, authorization: changed },
        ),
        // Existing immutable-query contract rejects any inaccessible pinned member.
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      await client.query('rollback');
      client.release();
      await pool.end();
    }
  },
  30000,
);
