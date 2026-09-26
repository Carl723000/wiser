import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlatformRequestContext } from '@wiser/platform-contracts';

import { buildApp } from '../src/app.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';
import { createDataFoundationGraphqlModule } from '../src/data-foundation/graphql-module.js';

const TENANT_ID = 'b9000000-0000-4000-8000-000000000001';
const PROJECT_ID = 'b9000000-0000-4000-8000-000000000002';
const ACTOR_ID = 'b9000000-0000-4000-8000-000000000003';
const SESSION_ID = 'b9000000-0000-4000-8000-000000000004';
const ITEM_ID = 'b9000000-0000-4000-8000-000000000005';
const VERSION_ID = 'b9000000-0000-4000-8000-000000000006';
const VIEW_ID = 'b9000000-0000-4000-8000-000000000007';
const SECRET = 'fixture-result-must-not-be-released';

const headers = {
  authorization: 'Bearer fixture-token',
  'x-wiser-tenant-id': TENANT_ID,
  'x-wiser-project-id': PROJECT_ID,
  'x-wiser-purpose': 'research',
};

function managedContext(): PlatformRequestContext {
  return {
    principal: {
      actorType: 'human',
      actorId: ACTOR_ID,
      authUserId: ACTOR_ID,
      sessionId: SESSION_ID,
      authenticationMethod: 'supabase_jwt',
    },
    authorization: {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      roles: ['data-reader'],
      scopes: ['data.catalog.read', 'data.query.execute', 'data.graph.read'],
      purpose: 'research',
      maxSecurityLevel: 'L1_INTERNAL',
      authzVersion: 7,
      resourceAccess: {
        revision: 5,
        fingerprint: 'a'.repeat(64),
        scope: {
          mode: 'managed',
          validUntil: '2099-01-01T00:00:00Z',
          permissions: {
            'source.discover': [
              { kind: 'version', dataItemId: ITEM_ID, versionId: VERSION_ID },
            ],
            'content.read': [
              { kind: 'version', dataItemId: ITEM_ID, versionId: VERSION_ID },
            ],
            'original.read': [],
            'result.export': [],
            'external.directory': [],
          },
        },
      },
    },
    traceId: 'b'.repeat(32),
  };
}

const openApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

type RequestCase = {
  readonly name: string;
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly output: unknown;
};

const cases: readonly RequestCase[] = [
  {
    name: 'REST catalog page',
    method: 'GET',
    url: '/api/data/v1/catalog/data-items?first=1',
    output: {
      items: [{ dataItemId: ITEM_ID, name: SECRET }],
      totalCount: 1,
    },
  },
  {
    name: 'REST saved-view link',
    method: 'POST',
    url: `/api/data/v1/explore/views/${VIEW_ID}/open`,
    output: { title: SECRET, queryId: VIEW_ID },
  },
  {
    name: 'REST graph expansion',
    method: 'POST',
    url: '/api/data/v1/graph/expand',
    payload: { entityId: 'station:fixture', maxDepth: 1 },
    output: { nodes: [{ id: ITEM_ID, label: SECRET }], edges: [] },
  },
  {
    name: 'GraphQL catalog page',
    method: 'POST',
    url: '/graphql',
    payload: {
      query: 'query { dataCatalog(first: 1) { nodes { name } } }',
    },
    output: {
      items: [
        { dataItemId: ITEM_ID, name: SECRET, securityLevel: 'L1_INTERNAL' },
      ],
    },
  },
  {
    name: 'GraphQL saved-view link',
    method: 'POST',
    url: '/graphql',
    payload: {
      query: `query { dataExploreView(input: {viewId: "${VIEW_ID}"}) }`,
    },
    output: { title: SECRET },
  },
  {
    name: 'GraphQL graph expansion',
    method: 'POST',
    url: '/graphql',
    payload: {
      query:
        'query { graphExpand(input: {entityId: "station:fixture", maxDepth: 1}) { nodes edges } }',
    },
    output: { nodes: [{ id: ITEM_ID, label: SECRET }], edges: [] },
  },
];

describe('governed read delivery after resource-specific revocation', () => {
  it.each(cases)(
    'withholds $name when only the resource grant changes during execution',
    async (testCase) => {
      let current = managedContext();
      const originalRevision = current.authorization.resourceAccess?.revision;
      const resolver = { resolve: vi.fn(() => Promise.resolve(current)) };
      const handler = {
        execute: vi.fn(() => {
          const before = current.authorization.resourceAccess!;
          current = {
            ...current,
            authorization: {
              ...current.authorization,
              resourceAccess: {
                revision: before.revision + 1,
                fingerprint: 'c'.repeat(64),
                scope: {
                  mode: 'managed',
                  validUntil: '2099-01-01T00:00:00Z',
                  permissions: {
                    'source.discover': [],
                    'content.read': [],
                    'original.read': [],
                    'result.export': [],
                    'external.directory': [],
                  },
                },
              },
            },
          };
          return Promise.resolve(testCase.output);
        }),
      };
      const app = buildApp({
        logger: false,
        modules: [
          createDataFoundationRestModule({ resolver, handler }),
          createDataFoundationGraphqlModule({ resolver, handler }),
        ],
      });
      openApps.push(app);

      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers,
        ...(testCase.payload === undefined
          ? {}
          : { payload: testCase.payload }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(SECRET);
      expect(response.headers['cache-control']).toContain('no-store');
      expect(handler.execute).toHaveBeenCalledOnce();
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
      expect(current.authorization.authzVersion).toBe(7);
      expect(originalRevision).toBe(5);
      expect(current.authorization.resourceAccess?.revision).toBe(6);
    },
  );

  it.each(cases.filter((entry) => entry.name.includes('saved-view')))(
    'withholds $name if the authenticated actor changes before delivery',
    async (testCase) => {
      let current = managedContext();
      const resolver = { resolve: vi.fn(() => Promise.resolve(current)) };
      const handler = {
        execute: vi.fn(() => {
          current = {
            ...current,
            principal: {
              ...current.principal,
              actorId: 'b9000000-0000-4000-8000-000000000008',
              authUserId: 'b9000000-0000-4000-8000-000000000008',
            },
          };
          return Promise.resolve(testCase.output);
        }),
      };
      const app = buildApp({
        logger: false,
        modules: [
          createDataFoundationRestModule({ resolver, handler }),
          createDataFoundationGraphqlModule({ resolver, handler }),
        ],
      });
      openApps.push(app);

      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers,
        ...(testCase.payload === undefined
          ? {}
          : { payload: testCase.payload }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain(SECRET);
      expect(handler.execute).toHaveBeenCalledOnce();
      expect(resolver.resolve).toHaveBeenCalledTimes(2);
      expect(current.authorization.authzVersion).toBe(7);
      expect(current.authorization.resourceAccess?.revision).toBe(5);
    },
  );
});
