import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { DATA_CAPABILITY_IDS } from '@wiser/data-contracts';
import {
  createPostgresResourceAuthorityLoader,
  ResourceScopedPrincipalResolver,
} from '@wiser/platform-auth';
import type { PlatformRequestContext } from '@wiser/platform-contracts';

import { buildApp } from '../src/app.js';
import { DataCapabilityHandler } from '../src/data-foundation/capability-handler.js';
import { createDataFoundationGeoProxyModule } from '../src/data-foundation/geo-proxy-module.js';
import { PostgresDataFoundationGeoAuthorityPort } from '../src/data-foundation/geo-proxy-ports.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';

const controlUrl =
  process.env['GOAL89_CONTROL_URL'] ??
  process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const dataUrl = process.env['DATA_TEST_DATABASE_URL'];

// Both URLs must point to disposable, migrated Goal89 databases. This fixture
// uses synthetic rows, never a real source file or an external map service.
it.skipIf(
  !controlUrl || !dataUrl || process.env['WISER_DATA_PG_INTEGRATION'] !== '1',
)(
  'keeps two projects and two readers separate at real catalog and map authority, including same-session revocation',
  async () => {
    const controlPool = new Pool({ connectionString: controlUrl, max: 1 });
    const dataPool = new Pool({ connectionString: dataUrl, max: 1 });
    let control: PoolClient | undefined;
    let data: PoolClient | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    const tenantId = 'b1000000-0000-4000-8000-000000000001';
    const ownerId = '10000000-0000-4000-8000-000000000005';
    const projects = [randomUUID(), randomUUID()] as const;
    const actors = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        token: 'goal89-map-alice',
        sessionId: randomUUID(),
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        token: 'goal89-map-bob',
        sessionId: randomUUID(),
      },
    ] as const;
    const sources = [
      {
        projectId: projects[0],
        actorId: actors[0].id,
        dataItemId: randomUUID(),
        versionId: randomUUID(),
        name: 'Goal89 map Alice A',
        tile: 'synthetic-tile-alice-a',
      },
      {
        projectId: projects[0],
        actorId: actors[1].id,
        dataItemId: randomUUID(),
        versionId: randomUUID(),
        name: 'Goal89 map Bob A',
        tile: 'synthetic-tile-bob-a',
      },
      {
        projectId: projects[1],
        actorId: actors[1].id,
        dataItemId: randomUUID(),
        versionId: randomUUID(),
        name: 'Goal89 map Bob B',
        tile: 'synthetic-tile-bob-b',
      },
    ] as const;
    const aliceGrantId = randomUUID();
    const dataRole = `goal89_map_${randomUUID().replaceAll('-', '')}`;

    try {
      control = await controlPool.connect();
      data = await dataPool.connect();
      await control.query('begin');
      await data.query('begin');

      for (const projectId of projects) {
        await control.query(
          "insert into platform.projects(id,tenant_id,slug,name_zh_cn,name_en,created_by_actor_id) values($1,$2,$3,'合成地图权限验收','Synthetic map access acceptance',$4)",
          [projectId, tenantId, `goal89-map-${projectId}`, ownerId],
        );
        await control.query(
          'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
          [projectId, tenantId, ownerId],
        );
      }
      for (const actor of actors) {
        await control.query(
          'insert into auth.sessions(id,user_id) values($1,$2)',
          [actor.sessionId, actor.id],
        );
      }
      for (const [index, source] of sources.entries()) {
        const resource = {
          kind: 'version' as const,
          dataItemId: source.dataItemId,
          versionId: source.versionId,
        };
        const packageId = randomUUID();
        const presetId = randomUUID();
        await control.query(
          "insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by) values($1,$2,1,$3,array['content.read'],array['data-steward'],'Synthetic map source permission',now()-interval '1 day',now()+interval '30 days',30,$4,$5)",
          [
            source.projectId,
            randomUUID(),
            JSON.stringify(resource),
            source.actorId,
            ownerId,
          ],
        );
        await control.query(
          "insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,1,$3,$4,array['content.read'],'Synthetic map source permission',$5)",
          [
            source.projectId,
            packageId,
            `Goal89 map package ${index}`,
            JSON.stringify([resource]),
            ownerId,
          ],
        );
        await control.query(
          "insert into platform_private.resource_preset_versions(project_id,preset_id,version,name,actions,max_days,approval_level,created_by) values($1,$2,1,'Synthetic map reader',array['content.read'],30,'ordinary',$3)",
          [source.projectId, presetId, ownerId],
        );
        await control.query(
          "insert into platform_private.resource_grants(id,project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) values($1,$2,$3,$4,1,$5,1,'research',now()-interval '1 minute',now()+interval '1 day',$6,$6,'Synthetic map boundary acceptance')",
          [
            index === 0 ? aliceGrantId : randomUUID(),
            source.projectId,
            source.actorId,
            packageId,
            presetId,
            ownerId,
          ],
        );
      }

      await data.query(
        `create role ${dataRole} nologin nosuperuser nobypassrls`,
      );
      await data.query(`grant ${dataRole} to current_user`);
      await data.query(`grant usage on schema catalog,security to ${dataRole}`);
      await data.query(
        `grant select on all tables in schema catalog to ${dataRole}`,
      );
      // The production Data runtime also has UPDATE. PostgreSQL requires it
      // for the authority port's SELECT ... FOR KEY SHARE on this version row.
      await data.query(
        `grant update on catalog.data_item_version to ${dataRole}`,
      );
      await data.query(
        `grant execute on all functions in schema security to ${dataRole}`,
      );
      for (const source of sources) {
        await data.query(
          "insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode) values($1,$2,$3,$3,$4,array['water-quality'],array['observed'],array['official'],'RAW',array['research'],'Synthetic provider','data.catalog.read','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL','SNAPSHOT')",
          [source.dataItemId, tenantId, source.projectId, source.name],
        );
        await data.query(
          "insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at,published_at) values($1,$2,$3,$4,1,'{}',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),'RAW','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL',now(),now())",
          [source.versionId, tenantId, source.projectId, source.dataItemId],
        );
        await data.query(
          "insert into catalog.spatial_extent(spatial_extent_id,tenant_id,project_id,data_item_id,version_id,source_geometry,source_crs,canonical_geometry,security_level) values($1,$2,$3,$4,$5,st_setsrid(st_makepoint(116.3913,39.9075),4326),'EPSG:4326',st_setsrid(st_makepoint(116.3913,39.9075),4490),'L1_INTERNAL')",
          [
            randomUUID(),
            tenantId,
            source.projectId,
            source.dataItemId,
            source.versionId,
          ],
        );
      }
      await data.query(`set local role ${dataRole}`);
      const activeRls = await data.query<{
        role: string;
        bypass: boolean;
        catalogRls: boolean;
        versionRls: boolean;
        spatialRls: boolean;
      }>(
        `select current_user::text "role",rolbypassrls bypass,
          row_security_active('catalog.data_item'::regclass) "catalogRls",
          row_security_active('catalog.data_item_version'::regclass) "versionRls",
          row_security_active('catalog.spatial_extent'::regclass) "spatialRls"
         from pg_roles where rolname=current_user`,
      );
      expect(activeRls.rows[0]).toEqual({
        role: dataRole,
        bypass: false,
        catalogRls: true,
        versionRls: true,
        spatialRls: true,
      });

      const authority = createPostgresResourceAuthorityLoader(
        async (sql, values) => ({
          rows: (await control!.query(sql, [...values])).rows,
        }),
      );
      const resolver = new ResourceScopedPrincipalResolver({
        base: {
          async resolve(input): Promise<PlatformRequestContext | null> {
            const actor = actors.find(
              (candidate) => candidate.token === input.token,
            );
            if (
              !actor ||
              input.tenantId !== tenantId ||
              !projects.some((projectId) => projectId === input.projectId) ||
              input.purpose !== 'research'
            )
              return null;
            // Both readers have a project context. Resource grants independently
            // decide which fixed versions they can actually read in each project.
            const session = await control!.query(
              'select 1 from auth.sessions where id=$1 and user_id=$2',
              [actor.sessionId, actor.id],
            );
            if (session.rowCount !== 1) return null;
            return {
              principal: {
                actorType: 'human',
                actorId: actor.id,
                authUserId: actor.id,
                sessionId: actor.sessionId,
                authenticationMethod: 'supabase_jwt',
              },
              authorization: {
                tenantId,
                projectId: input.projectId,
                purpose: 'research',
                roles: ['data-reader'],
                scopes: ['data.catalog.read', 'data.geo.read'],
                maxSecurityLevel: 'L1_INTERNAL',
                authzVersion: 1,
              },
              traceId: input.traceId,
            };
          },
        },
        load: authority,
      });
      const dataClient = data;
      const readPool = {
        connect: () =>
          Promise.resolve({
            async query(sql: string, values?: readonly unknown[]) {
              if (/^begin\b/i.test(sql))
                return dataClient.query('savepoint goal89_map_read');
              if (/^commit\b/i.test(sql))
                return dataClient.query('release savepoint goal89_map_read');
              if (/^rollback\b/i.test(sql))
                return dataClient.query(
                  'rollback to savepoint goal89_map_read',
                );
              return dataClient.query<Record<string, unknown>>(
                sql,
                values ? [...values] : undefined,
              );
            },
            release() {},
          }),
        end: () => Promise.resolve(),
      };
      const catalog = createPostgresDataReadRuntime(readPool).executors.filter(
        (executor) => executor.id === 'data.catalog.search',
      );
      if (catalog.length !== 1) throw new Error('Catalog executor is required');
      const handler = new DataCapabilityHandler({
        executors: DATA_CAPABILITY_IDS.map(
          (id) =>
            catalog.find((executor) => executor.id === id) ?? {
              id,
              execute: () => Promise.reject(new Error('Unexpected capability')),
            },
        ),
        audit: { record: () => Promise.resolve() },
      });
      const geoAuthority = new PostgresDataFoundationGeoAuthorityPort({
        pool: readPool,
        bucket: 'wiser-authority',
      });
      let revokeOnNextAliceTile = false;
      let upstreamCalls = 0;
      app = buildApp({
        logger: false,
        modules: [
          createDataFoundationRestModule({ resolver, handler }),
          createDataFoundationGeoProxyModule({
            resolver,
            authority: geoAuthority,
            proxy: {
              async request(input) {
                upstreamCalls++;
                const query = Object.fromEntries(input.query);
                const source = sources.find(
                  (candidate) => candidate.versionId === query['versionId'],
                );
                if (!source)
                  throw new Error('Unexpected synthetic map version');
                const actor = actors.find(
                  (candidate) => candidate.id === source.actorId,
                );
                expect(input.target).toBe('MARTIN');
                expect(input.method).toBe('GET');
                expect(input.path).toBe('/wiser_spatial_extent_mvt/0/0/0');
                expect(input.query).toHaveLength(5);
                expect(query).toEqual({
                  tenantId,
                  projectId: source.projectId,
                  versionId: source.versionId,
                  maxSecurityLevel: 'L1_INTERNAL',
                  policyVersion: '1',
                });
                expect(input.context.principal).toMatchObject({
                  actorType: 'human',
                  actorId: source.actorId,
                  sessionId: actor?.sessionId,
                });
                expect(input.context.authorization).toMatchObject({
                  tenantId,
                  projectId: source.projectId,
                  purpose: 'research',
                });
                const scope = input.context.authorization.resourceAccess?.scope;
                if (scope?.mode !== 'managed')
                  throw new Error('Expected managed map caller');
                expect(scope.permissions['content.read']).toContainEqual({
                  kind: 'version',
                  dataItemId: source.dataItemId,
                  versionId: source.versionId,
                });
                if (
                  revokeOnNextAliceTile &&
                  source.versionId === sources[0].versionId
                ) {
                  revokeOnNextAliceTile = false;
                  await control!.query(
                    'insert into platform_private.resource_revocations(grant_id,project_id,revoked_by,reason) values($1,$2,$3,$4)',
                    [
                      aliceGrantId,
                      projects[0],
                      ownerId,
                      'Synthetic in-flight map revocation',
                    ],
                  );
                }
                return {
                  status: 200,
                  contentType: 'application/vnd.mapbox-vector-tile',
                  body: new TextEncoder().encode(source.tile),
                };
              },
            },
            audit: { record: () => Promise.resolve() },
          }),
        ],
      });

      const headers = (actor: (typeof actors)[number], projectId: string) => ({
        authorization: `Bearer ${actor.token}`,
        'x-wiser-tenant-id': tenantId,
        'x-wiser-project-id': projectId,
        'x-wiser-purpose': 'research',
      });
      const list = async (
        actor: (typeof actors)[number],
        projectId: string,
      ) => {
        const response = await app!.inject({
          method: 'GET',
          url: '/api/data/v1/catalog/data-items?query=Goal89%20map&first=10&includeTotal=true',
          headers: headers(actor, projectId),
        });
        expect(response.statusCode, response.body).toBe(200);
        for (const hidden of sources.filter(
          (source) =>
            source.projectId !== projectId || source.actorId !== actor.id,
        )) {
          expect(response.body).not.toContain(hidden.name);
        }
        const parsed = z
          .object({
            items: z.array(
              z.object({ dataItemId: z.uuid(), name: z.string() }),
            ),
            totalCount: z.number().int(),
          })
          .parse(response.json());
        return { ...parsed, rawBody: response.body };
      };
      const tile = (
        actor: (typeof actors)[number],
        projectId: string,
        versionId: string,
      ) =>
        app!.inject({
          method: 'GET',
          url: `/api/data/v1/geo/tiles/vector/versions/${versionId}/0/0/0.pbf`,
          headers: headers(actor, projectId),
        });
      const names = (result: Awaited<ReturnType<typeof list>>) =>
        result.items.map((item) => item.name);

      for (const actor of actors) {
        for (const projectId of projects) {
          const context = await resolver.resolve({
            token: actor.token,
            tenantId,
            projectId,
            purpose: 'research',
            traceId: 'c'.repeat(32),
          });
          expect(context?.principal.sessionId).toBe(actor.sessionId);
          expect(context?.authorization.resourceAccess?.scope.mode).toBe(
            'managed',
          );
        }
      }

      expect(names(await list(actors[0], projects[0]))).toEqual([
        sources[0].name,
      ]);
      expect(names(await list(actors[1], projects[0]))).toEqual([
        sources[1].name,
      ]);
      expect(names(await list(actors[0], projects[1]))).toEqual([]);
      expect(names(await list(actors[1], projects[1]))).toEqual([
        sources[2].name,
      ]);
      expect((await list(actors[0], projects[1])).totalCount).toBe(0);
      expect((await list(actors[1], projects[0])).totalCount).toBe(1);

      for (const [actor, source] of [
        [actors[0], sources[0]],
        [actors[1], sources[1]],
        [actors[1], sources[2]],
      ] as const) {
        const response = await tile(actor, source.projectId, source.versionId);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toBe(source.tile);
      }
      for (const [actor, projectId, hidden] of [
        [actors[0], projects[0], sources[1]],
        [actors[0], projects[1], sources[2]],
        [actors[1], projects[0], sources[0]],
        [actors[1], projects[0], sources[2]],
      ] as const) {
        const callsBefore = upstreamCalls;
        const response = await tile(actor, projectId, hidden.versionId);
        expect(response.statusCode, response.body).toBe(404);
        expect(response.body).not.toContain(hidden.name);
        expect(response.body).not.toContain(hidden.tile);
        expect(upstreamCalls).toBe(callsBefore);
      }

      const aliceBefore = await resolver.resolve({
        token: actors[0].token,
        tenantId,
        projectId: projects[0],
        purpose: 'research',
        traceId: 'a'.repeat(32),
      });
      revokeOnNextAliceTile = true;
      const callsBeforeRevocation = upstreamCalls;
      const inFlight = await tile(actors[0], projects[0], sources[0].versionId);
      expect(inFlight.statusCode, inFlight.body).toBe(403);
      expect(inFlight.body).not.toContain(sources[0].name);
      expect(inFlight.body).not.toContain(sources[0].tile);
      expect(revokeOnNextAliceTile).toBe(false);
      expect(upstreamCalls).toBe(callsBeforeRevocation + 1);
      const aliceAfter = await resolver.resolve({
        token: actors[0].token,
        tenantId,
        projectId: projects[0],
        purpose: 'research',
        traceId: 'b'.repeat(32),
      });
      expect(aliceAfter?.principal.sessionId).toBe(
        aliceBefore?.principal.sessionId,
      );
      expect(
        aliceAfter?.authorization.resourceAccess?.revision,
      ).toBeGreaterThan(
        aliceBefore?.authorization.resourceAccess?.revision ?? 0,
      );
      const revoked = await list(actors[0], projects[0]);
      expect(revoked).toMatchObject({ items: [], totalCount: 0 });
      expect(revoked.rawBody).not.toContain(sources[0].name);
      const callsAfterRevocation = upstreamCalls;
      const deniedAfter = await tile(
        actors[0],
        projects[0],
        sources[0].versionId,
      );
      expect(deniedAfter.statusCode).toBe(404);
      expect(deniedAfter.body).not.toContain(sources[0].tile);
      expect(upstreamCalls).toBe(callsAfterRevocation);
      expect(names(await list(actors[1], projects[0]))).toEqual([
        sources[1].name,
      ]);
      expect(
        (await tile(actors[1], projects[0], sources[1].versionId)).body,
      ).toBe(sources[1].tile);
    } finally {
      await app?.close();
      if (data) {
        await data.query('rollback').catch(() => undefined);
        data.release();
      }
      if (control) {
        await control.query('rollback').catch(() => undefined);
        control.release();
      }
      await Promise.all([controlPool.end(), dataPool.end()]);
    }
  },
  30_000,
);
