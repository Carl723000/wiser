import { assertResourceManagementPolicy } from '../../../packages/platform-auth/src/resource-management-policy.js';
import { z } from 'zod';
import { createDataResourcePackageValidator } from '../src/data-foundation/resource-package-validator.js';
import { PostgresProjectionReadAuthority } from '../src/data-foundation/query-adapters.js';
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
      assetId: randomUUID(),
      evidenceId: randomUUID(),
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
              'content.read': [
                {
                  kind: 'version',
                  dataItemId: first.dataItemId,
                  versionId: first.versionId,
                },
              ],
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
        await client.query(
          `insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,raw_storage_key,lifecycle_state,security_level) values($1::uuid,$2,$3,digest($1::text,'sha256'),1,$1::text,'RAW','L1_INTERNAL')`,
          [s.assetId, tenant, project],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,security_level,content_blob_id,lifecycle_state) values($1::uuid,$2,$3,$4,$1::text,digest($1::text,'sha256'),'text/plain',1,'L1_INTERNAL',$1::uuid,'RAW')`,
          [s.assetId, tenant, project, s.versionId],
        );
        await client.query(
          `insert into knowledge.evidence_fragment(evidence_fragment_id,tenant_id,project_id,data_item_id,version_id,asset_id,locator,content_hash,excerpt,security_level) values($1,$2,$3,$4,$5,$6,'{}',decode(repeat('ab',32),'hex'),'Synthetic evidence','L1_INTERNAL')`,
          [s.evidenceId, tenant, project, s.dataItemId, s.versionId, s.assetId],
        );
      }
      await client.query(`set local role ${role}`);
      const validatePackage = createDataResourcePackageValidator(runtimePool);
      const packageInput = {
        context: {
          principal: context.principal,
          authorization: context.authorization,
          traceId: context.traceId,
        },
        signal: context.signal,
        command: {
          projectId: project,
          packageId: randomUUID(),
          expectedVersion: 0,
          name: 'Authorized source package',
          resources: [
            {
              kind: 'version' as const,
              dataItemId: first.dataItemId,
              versionId: first.versionId,
            },
          ],
          allowedActions: ['content.read' as const],
          licenseBasis: 'Approved synthetic fixture',
          reason: 'Verify exact version availability',
        },
      };
      expect(await validatePackage(packageInput)).toBe(true);
      expect(
        await validatePackage({
          ...packageInput,
          command: {
            ...packageInput.command,
            resources: [
              {
                kind: 'version',
                dataItemId: second.dataItemId,
                versionId: second.versionId,
              },
            ],
          },
        }),
      ).toBe(false);
      expect(
        await validatePackage({
          ...packageInput,
          command: { ...packageInput.command, projectId: randomUUID() },
        }),
      ).toBe(false);
      expect(
        await validatePackage({ ...packageInput, signal: AbortSignal.abort() }),
      ).toBe(false);
      expect(
        await validatePackage({
          ...packageInput,
          command: {
            ...packageInput.command,
            resources: [{ kind: 'external-source', sourceId: randomUUID() }],
          },
        }),
      ).toBe(false);
      // Independently authorized management must not require a personal content grant.
      const manager = structuredClone(packageInput.context);
      manager.authorization.scopes = ['platform.membership.manage'];
      manager.authorization.roles = ['source-steward'];
      manager.authorization.resourceAccess!.scope.permissions['content.read'] =
        [];
      const now = new Date(),
        end = new Date(now.getTime() + 3600000);
      const managementPermit = await assertResourceManagementPolicy(
        {
          context: manager,
          client: {
            release() {},
            query: async <Row>() => ({
              rows: [
                {
                  snapshot: {
                    mode: 'managed',
                    tenantId: tenant,
                    projectId: project,
                    actorId: actor,
                    purpose: manager.authorization.purpose,
                    revision: 1,
                    now: now.toISOString(),
                    grants: [],
                    limits: [
                      {
                        id: randomUUID(),
                        version: 1,
                        tenantId: tenant,
                        projectId: project,
                        resource: packageInput.command.resources[0],
                        allowedActions: ['content.read'],
                        managementRoles: ['source-steward'],
                        licenseBasis: 'Synthetic independent permit',
                        status: 'active',
                        startsAt: new Date(
                          now.getTime() - 3600000,
                        ).toISOString(),
                        expiresAt: end.toISOString(),
                        maxGrantDays: 1,
                      },
                    ],
                  },
                },
              ] as Row[],
              rowCount: 1,
            }),
          },
        },
        packageInput.command.resources,
        packageInput.command.allowedActions,
      );
      const managementRequest = {
        ...packageInput,
        context: manager,
        managementPermit,
      };
      expect(await validatePackage(managementRequest)).toBe(true);
      expect(
        manager.authorization.resourceAccess!.scope.permissions['content.read'],
      ).toEqual([]);
      const managerCatalog = createPostgresDataReadRuntime(
        runtimePool,
      ).executors.find((e) => e.id === 'data.catalog.search')!;
      await expect(
        managerCatalog.execute(
          { query: 'Synthetic', includeTotal: true, first: 10 },
          {
            ...context,
            ...manager,
            authorization: {
              ...manager.authorization,
              scopes: ['data.catalog.read'],
            },
          },
        ),
      ).resolves.toMatchObject({ totalCount: 0, items: [] });
      const projectionAuthority = new PostgresProjectionReadAuthority({
        pool: runtimePool,
      });
      const projectionRequest = {
        scope: {
          tenantId: tenant,
          projectId: project,
          maxSecurityLevel: context.effectiveMaxSecurityLevel,
          maximumPolicyVersion: 1,
          resourceAccess: context.authorization.resourceAccess!,
        },
        input: {},
        signal: context.signal,
      };
      const reference = (s: typeof first) => ({
        dataItemId: s.dataItemId,
        versionId: s.versionId,
        evidenceId: s.evidenceId,
      });
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          reference(first),
        ]),
      ).resolves.toBeUndefined();
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          reference(second),
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_BACKEND_RESULT' });
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          { evidenceId: first.evidenceId },
        ]),
      ).resolves.toBeUndefined();
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          { evidenceId: second.evidenceId },
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_BACKEND_RESULT' });
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          { evidenceId: first.evidenceId, dataItemId: first.dataItemId },
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_BACKEND_RESULT' });

      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          { ...reference(first), evidenceId: second.evidenceId },
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_BACKEND_RESULT' });
      await client.query('reset role');
      await client.query(
        "update catalog.data_item set publication_status='WITHDRAWN' where data_item_id=$1",
        [first.dataItemId],
      );
      await client.query(`set local role ${role}`);
      expect(await validatePackage(packageInput)).toBe(false);
      await expect(
        projectionAuthority.assertVisible(projectionRequest, [
          reference(first),
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_BACKEND_RESULT' });
      await client.query('reset role');
      await client.query(
        "update catalog.data_item set publication_status='PUBLISHED' where data_item_id=$1",
        [first.dataItemId],
      );
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
        (source) => ({
          kind: 'version',
          dataItemId: source.dataItemId,
          versionId: source.versionId,
        }),
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
        {
          kind: 'version',
          dataItemId: second.dataItemId,
          versionId: second.versionId,
        },
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
