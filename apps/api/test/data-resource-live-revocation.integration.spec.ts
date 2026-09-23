import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { createDataFoundationGraphqlModule } from '../src/data-foundation/graphql-module.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';

type McpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;
type McpAuthorizer = (
  request: IncomingMessage,
) => Promise<McpRequestHandler | null>;

// Keep the API test inside its TypeScript root while loading the real sibling
// MCP host at runtime; this adds no API-to-MCP production dependency.
const { createAgentHttpAuthorizer } = (await import(
  new URL('../../mcp/src/platform/agent-http-authorizer.ts', import.meta.url)
    .href
)) as {
  createAgentHttpAuthorizer: (options: {
    dataApiUrl: string;
    fetch: typeof fetch;
  }) => McpAuthorizer;
};
const { closeWiserMcpHttpServer, createWiserMcpHttpServer } = (await import(
  new URL('../../mcp/src/http-server.ts', import.meta.url).href
)) as {
  createWiserMcpHttpServer: (options: {
    ready: () => boolean;
    authorize: McpAuthorizer;
  }) => Server;
  closeWiserMcpHttpServer: (server: Server) => Promise<void>;
};
if (
  typeof createAgentHttpAuthorizer !== 'function' ||
  typeof createWiserMcpHttpServer !== 'function' ||
  typeof closeWiserMcpHttpServer !== 'function'
) {
  throw new Error('Expected MCP host modules are unavailable');
}

const controlUrl =
  process.env['GOAL89_CONTROL_URL'] ??
  process.env['WISER_RESOURCE_TEST_DATABASE_URL'];
const dataUrl = process.env['DATA_TEST_DATABASE_URL'];

// Both databases must be disposable, migrated Goal89 fixtures. No real source
// files or remotely shared project data enter this test.
it.skipIf(
  !controlUrl || !dataUrl || process.env['WISER_DATA_PG_INTEGRATION'] !== '1',
)(
  'rechecks two fixed-resource readers through REST, GraphQL and MCP in their original sessions after one grant is revoked',
  async () => {
    const controlPool = new Pool({ connectionString: controlUrl, max: 1 });
    const dataPool = new Pool({ connectionString: dataUrl, max: 1 });
    let control: PoolClient | undefined;
    let data: PoolClient | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    let mcpServer: ReturnType<typeof createWiserMcpHttpServer> | undefined;
    const tenantId = 'b1000000-0000-4000-8000-000000000001';
    const ownerId = '10000000-0000-4000-8000-000000000005';
    const actors = [
      {
        id: '10000000-0000-4000-8000-000000000001',
        token: `wdc1.wdc_${'1'.repeat(22)}.${'1'.repeat(43)}`,
        mcpToken: 'goal89-mcp-reader-one',
        connectionId: randomUUID(),
        clientId: randomUUID(),
        delegationId: randomUUID(),
        sessionId: randomUUID(),
      },
      {
        id: '10000000-0000-4000-8000-000000000003',
        token: `wdc1.wdc_${'2'.repeat(22)}.${'2'.repeat(43)}`,
        mcpToken: 'goal89-mcp-reader-two',
        connectionId: randomUUID(),
        clientId: randomUUID(),
        delegationId: randomUUID(),
        sessionId: randomUUID(),
      },
    ] as const;
    const projectId = randomUUID();
    const sources = [
      {
        dataItemId: randomUUID(),
        versionId: randomUUID(),
        name: 'Goal89 live source A',
      },
      {
        dataItemId: randomUUID(),
        versionId: randomUUID(),
        name: 'Goal89 live source B',
      },
    ] as const;
    const packages = [randomUUID(), randomUUID()] as const;
    const readPreset = randomUUID();
    const readExportPreset = randomUUID();
    const firstGrant = randomUUID();
    const dataRole = `goal89_live_${randomUUID().replaceAll('-', '')}`;
    const resource = (index: 0 | 1) => ({
      kind: 'version' as const,
      dataItemId: sources[index].dataItemId,
      versionId: sources[index].versionId,
    });

    try {
      control = await controlPool.connect();
      data = await dataPool.connect();
      await control.query('begin');
      await data.query('begin');

      await control.query(
        "insert into platform.projects(id,tenant_id,slug,name_zh_cn,name_en,created_by_actor_id) values($1,$2,$3,'权限隔离验收','Resource access acceptance',$4)",
        [projectId, tenantId, `goal89-${projectId}`, ownerId],
      );
      for (const actor of actors) {
        await control.query(
          'insert into auth.sessions(id,user_id) values($1,$2)',
          [actor.sessionId, actor.id],
        );
      }
      await control.query(
        'insert into platform_private.resource_access_settings(project_id,tenant_id,enabled_by) values($1,$2,$3)',
        [projectId, tenantId, ownerId],
      );
      for (const index of [0, 1] as const) {
        const actions =
          index === 0 ? ['content.read'] : ['content.read', 'result.export'];
        await control.query(
          "insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by) values($1,$2,1,$3,$4,array['data-steward'],'Synthetic source permission',now()-interval '1 day',now()+interval '30 days',30,$5,$6)",
          [
            projectId,
            randomUUID(),
            JSON.stringify(resource(index)),
            actions,
            actors[0].id,
            ownerId,
          ],
        );
        await control.query(
          "insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,1,$3,$4,$5,'Synthetic source permission',$6)",
          [
            projectId,
            packages[index],
            `Goal89 package ${index}`,
            JSON.stringify([resource(index)]),
            actions,
            ownerId,
          ],
        );
      }
      await control.query(
        "insert into platform_private.resource_preset_versions(project_id,preset_id,version,name,actions,max_days,approval_level,created_by) values($1,$2,1,'Read only',array['content.read'],30,'ordinary',$4),($1,$3,1,'Read and export',array['content.read','result.export'],30,'important',$4)",
        [projectId, readPreset, readExportPreset, ownerId],
      );
      for (const [actorId, packageId, presetId, grantId] of [
        [actors[0].id, packages[0], readPreset, firstGrant],
        [actors[0].id, packages[1], readPreset, randomUUID()],
        [actors[1].id, packages[1], readExportPreset, randomUUID()],
      ]) {
        await control.query(
          "insert into platform_private.resource_grants(id,project_id,actor_id,package_id,package_version,preset_id,preset_version,purpose,starts_at,expires_at,created_by,approved_by,reason) values($1,$2,$3,$4,1,$5,1,'agent-data',now()-interval '1 minute',now()+interval '1 day',$6,$6,'Synthetic same-session acceptance')",
          [grantId, projectId, actorId, packageId, presetId, ownerId],
        );
      }

      await data.query(
        `create role ${dataRole} nologin nosuperuser nobypassrls`,
      );
      await data.query(`grant ${dataRole} to current_user`);
      await data.query(
        `grant usage on schema catalog,ingestion,service,security to ${dataRole}`,
      );
      await data.query(
        `grant select on all tables in schema catalog,ingestion,service to ${dataRole}`,
      );
      await data.query(
        `grant execute on all functions in schema security,service to ${dataRole}`,
      );
      for (const source of sources) {
        await data.query(
          "insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode) values($1,$2,$3,$3,$4,array['water-quality'],array['observed'],array['official'],'RAW',array['research'],'Synthetic provider','data.catalog.read','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL','SNAPSHOT')",
          [source.dataItemId, tenantId, projectId, source.name],
        );
        await data.query(
          "insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at,published_at) values($1,$2,$3,$4,1,'{}',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),'RAW','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL',now(),now())",
          [source.versionId, tenantId, projectId, source.dataItemId],
        );
        const assetId = randomUUID();
        await data.query(
          "insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,raw_storage_key,lifecycle_state,security_level) values($1,$2,$3,digest($4,'sha256'),1,$4,'RAW','L1_INTERNAL')",
          [assetId, tenantId, projectId, `synthetic/${assetId}`],
        );
        await data.query(
          "insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,security_level,content_blob_id,lifecycle_state) values($1,$2,$3,$4,$5,digest($5,'sha256'),'text/plain',1,'L1_INTERNAL',$1,'RAW')",
          [
            assetId,
            tenantId,
            projectId,
            source.versionId,
            `synthetic/${assetId}`,
          ],
        );
      }
      await data.query(`set local role ${dataRole}`);

      const queryControl = createPostgresResourceAuthorityLoader(
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
              input.projectId !== projectId ||
              input.purpose !== 'agent-data'
            )
              return null;
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
                projectId,
                purpose: 'agent-data',
                roles: ['data-reader'],
                scopes: ['data.catalog.read'],
                maxSecurityLevel: 'L1_INTERNAL',
                authzVersion: 1,
              },
              traceId: input.traceId,
            };
          },
        },
        load: queryControl,
      });
      const dataClient = data;
      const readPool = {
        connect: () =>
          Promise.resolve({
            async query(sql: string, values?: readonly unknown[]) {
              if (/^begin\b/i.test(sql))
                return dataClient.query('savepoint goal89_live_read');
              if (/^commit\b/i.test(sql))
                return dataClient.query('release savepoint goal89_live_read');
              if (/^rollback\b/i.test(sql))
                return dataClient.query(
                  'rollback to savepoint goal89_live_read',
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
        (executor) =>
          executor.id === 'data.catalog.search' ||
          executor.id === 'data.catalog.get',
      );
      if (catalog.length !== 2)
        throw new Error('Catalog executors are required');
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
      app = buildApp({
        logger: false,
        modules: [
          createDataFoundationRestModule({ resolver, handler }),
          createDataFoundationGraphqlModule({ resolver, handler }),
        ],
      });

      const apiFetch: typeof fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const requestHeaders = new Headers(init?.headers);
        if (url.pathname === '/api/platform/v1/agent-connections/exchange') {
          const bearer = requestHeaders.get('authorization');
          const actor = actors.find(
            ({ mcpToken }) => bearer === `Bearer ${mcpToken}`,
          );
          if (actor === undefined) {
            return Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 });
          }
          const expiresAt = new Date(Date.now() + 60_000).toISOString();
          return Response.json({
            connection: {
              connectionId: actor.connectionId,
              clientId: actor.clientId,
              delegationId: actor.delegationId,
              tenantId,
              projectId,
              scopes: ['data.catalog.read'],
              purpose: 'agent-data',
              maxSecurityLevel: 'L1_INTERNAL',
              status: 'active',
              expiresAt,
            },
            token: actor.token,
            expiresAt,
          });
        }
        if (
          !url.pathname.startsWith('/api/data/v1/') ||
          init?.method !== 'GET'
        ) {
          throw new Error('Unexpected synthetic MCP Data API request');
        }
        const response = await app!.inject({
          method: 'GET',
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(requestHeaders),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: {
            'Content-Type': String(
              response.headers['content-type'] ?? 'application/json',
            ),
          },
        });
      };
      mcpServer = createWiserMcpHttpServer({
        ready: () => true,
        authorize: createAgentHttpAuthorizer({
          dataApiUrl: 'http://api.invalid/api/data/v1/',
          fetch: apiFetch,
        }),
      });
      mcpServer.listen(0, '127.0.0.1');
      await once(mcpServer, 'listening');
      const mcpOrigin = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
      let mcpRequestId = 0;
      const callMcp = async (
        token: string,
        name: string,
        args: Readonly<Record<string, unknown>>,
      ) => {
        const response = await fetch(`${mcpOrigin}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-03-26',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++mcpRequestId,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        });
        expect(response.status).toBe(200);
        return z
          .object({
            result: z.object({
              isError: z.boolean().optional(),
              structuredContent: z
                .object({ ok: z.boolean(), data: z.json().optional() })
                .passthrough(),
            }),
          })
          .parse(await response.json());
      };
      const readMcp = async (token: string) => {
        const result = await callMcp(token, 'data_catalog_search', {
          query: 'Goal89 live',
          first: 10,
          includeTotal: true,
        });
        expect(result.result.structuredContent.ok).toBe(true);
        return z
          .object({
            items: z.array(z.object({ dataItemId: z.uuid() })),
            totalCount: z.number().int(),
          })
          .parse(result.result.structuredContent.data);
      };
      const readMcpItem = (token: string, dataItemId: string) =>
        callMcp(token, 'data_catalog_get', { dataItemId });

      const missingMcpIdentity = await fetch(`${mcpOrigin}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++mcpRequestId,
          method: 'tools/call',
          params: {
            name: 'data_catalog_search',
            arguments: { query: 'Goal89 live', first: 10 },
          },
        }),
      });
      expect(missingMcpIdentity.status).toBe(401);

      const headers = (token: string) => ({
        authorization: `Bearer ${token}`,
        'x-wiser-tenant-id': tenantId,
        'x-wiser-project-id': projectId,
        'x-wiser-purpose': 'agent-data',
      });
      const readRest = async (token: string) => {
        const response = await app!.inject({
          method: 'GET',
          url: '/api/data/v1/catalog/data-items?query=Goal89%20live&first=10&includeTotal=true',
          headers: headers(token),
        });
        expect(response.statusCode, response.body).toBe(200);
        return z
          .object({
            items: z.array(z.object({ dataItemId: z.uuid() })),
            totalCount: z.number().int(),
          })
          .parse(response.json());
      };
      const readItem = (token: string, dataItemId: string) =>
        app!.inject({
          method: 'GET',
          url: `/api/data/v1/catalog/data-items/${dataItemId}`,
          headers: headers(token),
        });
      const readGraphql = async (token: string) => {
        const response = await app!.inject({
          method: 'POST',
          url: '/graphql',
          headers: headers(token),
          payload: {
            query:
              'query { dataCatalog(filter: { query: "Goal89 live" }, first: 10) { nodes { dataItemId } } }',
          },
        });
        expect(response.statusCode).toBe(200);
        return z
          .object({
            data: z.object({
              dataCatalog: z.object({
                nodes: z.array(z.object({ dataItemId: z.uuid() })),
              }),
            }),
          })
          .parse(response.json());
      };
      const ids = (values: readonly { dataItemId: string }[]) =>
        values.map((value) => value.dataItemId).sort();
      const bothIds = ids(sources);
      const secondId = [sources[1].dataItemId];
      const firstInitial = await readRest(actors[0].token);
      const secondInitial = await readRest(actors[1].token);
      expect(ids(firstInitial.items)).toEqual(bothIds);
      expect(firstInitial.totalCount).toBe(2);
      expect(ids(secondInitial.items)).toEqual(secondId);
      expect(secondInitial.totalCount).toBe(1);
      expect(
        (await readItem(actors[0].token, sources[0].dataItemId)).statusCode,
      ).toBe(200);
      expect(
        (await readItem(actors[1].token, sources[0].dataItemId)).statusCode,
      ).toBe(404);
      expect(
        ids((await readGraphql(actors[0].token)).data.dataCatalog.nodes),
      ).toEqual(bothIds);
      expect(
        ids((await readGraphql(actors[1].token)).data.dataCatalog.nodes),
      ).toEqual(secondId);
      const firstMcpInitial = await readMcp(actors[0].mcpToken);
      const secondMcpInitial = await readMcp(actors[1].mcpToken);
      expect(ids(firstMcpInitial.items)).toEqual(bothIds);
      expect(firstMcpInitial.totalCount).toBe(2);
      expect(ids(secondMcpInitial.items)).toEqual(secondId);
      expect(secondMcpInitial.totalCount).toBe(1);
      expect(
        (await readMcpItem(actors[0].mcpToken, sources[0].dataItemId)).result
          .structuredContent.ok,
      ).toBe(true);
      const initiallyDeniedMcpItem = await readMcpItem(
        actors[1].mcpToken,
        sources[0].dataItemId,
      );
      expect(initiallyDeniedMcpItem.result.isError).toBe(true);
      expect(initiallyDeniedMcpItem.result.structuredContent.ok).toBe(false);
      expect(JSON.stringify(initiallyDeniedMcpItem)).not.toContain(
        sources[0].name,
      );
      expect(JSON.stringify(initiallyDeniedMcpItem)).not.toContain(
        sources[0].dataItemId,
      );
      const firstBefore = await resolver.resolve({
        token: actors[0].token,
        tenantId,
        projectId,
        purpose: 'agent-data',
        traceId: 'a'.repeat(32),
      });
      const secondBefore = await resolver.resolve({
        token: actors[1].token,
        tenantId,
        projectId,
        purpose: 'agent-data',
        traceId: 'b'.repeat(32),
      });
      const firstScope = firstBefore?.authorization.resourceAccess?.scope;
      const secondScope = secondBefore?.authorization.resourceAccess?.scope;
      if (firstScope?.mode !== 'managed' || secondScope?.mode !== 'managed') {
        throw new Error('Both test actors must have managed resource scopes');
      }
      expect(firstScope.permissions['result.export']).toEqual([]);
      expect(secondScope.permissions['result.export']).toEqual([resource(1)]);

      await control.query(
        'insert into platform_private.resource_revocations(grant_id,project_id,revoked_by,reason) values($1,$2,$3,$4)',
        [firstGrant, projectId, ownerId, 'Synthetic selective revocation'],
      );
      const firstAfter = await resolver.resolve({
        token: actors[0].token,
        tenantId,
        projectId,
        purpose: 'agent-data',
        traceId: 'c'.repeat(32),
      });
      expect(firstAfter?.principal.sessionId).toBe(
        firstBefore?.principal.sessionId,
      );
      expect(
        firstAfter?.authorization.resourceAccess?.revision,
      ).toBeGreaterThan(
        firstBefore?.authorization.resourceAccess?.revision ?? 0,
      );
      expect(firstAfter?.authorization.resourceAccess?.scope.mode).toBe(
        'managed',
      );
      const firstRevoked = await readRest(actors[0].token);
      expect(ids(firstRevoked.items)).toEqual(secondId);
      expect(firstRevoked.totalCount).toBe(1);
      const deniedItem = await readItem(actors[0].token, sources[0].dataItemId);
      expect(deniedItem.statusCode).toBe(404);
      expect(deniedItem.body).not.toContain(sources[0].name);
      expect(
        ids((await readGraphql(actors[0].token)).data.dataCatalog.nodes),
      ).toEqual(secondId);
      const firstMcpRevoked = await readMcp(actors[0].mcpToken);
      expect(ids(firstMcpRevoked.items)).toEqual(secondId);
      expect(firstMcpRevoked.totalCount).toBe(1);
      const revokedMcpItem = await readMcpItem(
        actors[0].mcpToken,
        sources[0].dataItemId,
      );
      expect(revokedMcpItem.result.isError).toBe(true);
      expect(revokedMcpItem.result.structuredContent.ok).toBe(false);
      expect(JSON.stringify(revokedMcpItem)).not.toContain(sources[0].name);
      expect(JSON.stringify(revokedMcpItem)).not.toContain(
        sources[0].dataItemId,
      );
      expect(ids((await readMcp(actors[1].mcpToken)).items)).toEqual(secondId);
      expect(
        (await readMcpItem(actors[1].mcpToken, sources[1].dataItemId)).result
          .structuredContent.ok,
      ).toBe(true);
      expect(ids((await readRest(actors[1].token)).items)).toEqual(secondId);
      expect(
        ids((await readGraphql(actors[1].token)).data.dataCatalog.nodes),
      ).toEqual(secondId);
    } finally {
      if (mcpServer) await closeWiserMcpHttpServer(mcpServer);
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
