import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type {
  AuthorizationQuery,
  DelegatedCredentialAuthorizationQuery,
  PlatformDelegationTransactionPool,
  SupabaseClaimsClient,
} from '@wiser/platform-auth';

import { buildApp } from '../src/app.js';
import {
  createPlatformAuthModuleFromEnvironment,
  createPlatformAuthRuntimeFromEnvironment,
  loadPlatformAuthRuntimeConfig,
  type PlatformAuthRuntimeFactories,
} from '../src/platform/auth-runtime.js';

const USER_ID = 'f1000000-0000-4000-8000-000000000001';
const SESSION_ID = 'f1000000-0000-4000-8000-000000000002';
const TENANT_ID = 'f1000000-0000-4000-8000-000000000003';
const PROJECT_ID = 'f1000000-0000-4000-8000-000000000004';

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('WISER platform auth runtime', () => {
  it('registers project management only with its explicit server switch', async () => {
    const env = {
      WISER_AUTH_MODE: 'supabase',
      SUPABASE_URL: 'http://127.0.0.1:56321',
      SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
      WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
        activeKeyId: 'test',
        keys: { test: Buffer.alloc(32, 7).toString('base64url') },
      }),
    };
    const factories: PlatformAuthRuntimeFactories = {
      createClaimsClient: () => ({
        getClaims: () => Promise.resolve({ data: null, error: null }),
      }),
      createAuthorizationDatabase: () => ({
        query: () => Promise.resolve({ rows: [] }),
        delegatedCredentialQuery: () => Promise.resolve({ rows: [] }),
        transactionPool: {
          connect: () => Promise.reject(new Error('No database call expected')),
        },
        close: () => Promise.resolve(),
      }),
    };
    for (const enabled of [false, true]) {
      const module = createPlatformAuthModuleFromEnvironment(
        {
          ...env,
          ...(enabled ? { WISER_PROJECT_ACCESS_ENABLED: 'true' } : {}),
        },
        factories,
      )!;
      const app = buildApp({ logger: false, modules: [module] });
      openApps.push(app);
      expect(
        (await app.inject('/api/platform/v1/access/projects')).statusCode,
      ).toBe(enabled ? 401 : 404);
    }
    expect(() =>
      loadPlatformAuthRuntimeConfig({
        ...env,
        WISER_PROJECT_ACCESS_ENABLED: 'yes',
      }),
    ).toThrow('WISER_PROJECT_ACCESS_ENABLED');
  });

  it('registers Agent routes in the actual configured runtime', async () => {
    const module = createPlatformAuthModuleFromEnvironment(
      {
        WISER_AUTH_MODE: 'supabase',
        SUPABASE_URL: 'http://127.0.0.1:56321',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
        WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
          activeKeyId: 'test',
          keys: { test: Buffer.alloc(32, 7).toString('base64url') },
        }),
        WISER_AGENT_MCP_RESOURCE: 'https://mcp.example.test/mcp',
        WISER_AGENT_AUTH_ISSUER: 'https://auth.example.test/auth/v1',
      },
      {
        createClaimsClient: () => ({
          getClaims: () => Promise.resolve({ data: null, error: null }),
        }),
        createAuthorizationDatabase: () => ({
          query: () => Promise.resolve({ rows: [] }),
          delegatedCredentialQuery: () => Promise.resolve({ rows: [] }),
          transactionPool: {
            connect: () =>
              Promise.reject(
                new Error(
                  'Unauthenticated calls must not access the database.',
                ),
              ),
          },
          close: () => Promise.resolve(),
        }),
      },
    );
    expect(module).not.toBeNull();
    const app = buildApp({
      logger: false,
      modules: module === null ? [] : [module],
    });
    openApps.push(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/v1/agent-connections',
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires an explicit paired public resource and issuer for Agent OAuth mode', () => {
    const environment = {
      WISER_AUTH_MODE: 'supabase',
      SUPABASE_URL: 'http://127.0.0.1:56321',
      SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
      WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
        activeKeyId: 'test',
        keys: { test: Buffer.alloc(32, 7).toString('base64url') },
      }),
      WISER_AGENT_MCP_RESOURCE: 'https://mcp.example.test/mcp',
    };
    expect(() => loadPlatformAuthRuntimeConfig(environment)).toThrow(
      'WISER_AGENT_AUTH_ISSUER',
    );
    const configured = loadPlatformAuthRuntimeConfig({
      ...environment,
      WISER_AGENT_AUTH_ISSUER: 'https://auth.example.test/auth/v1',
    });
    expect(configured).toMatchObject({
      agent: {
        resource: environment.WISER_AGENT_MCP_RESOURCE,
        issuer: 'https://auth.example.test/auth/v1',
      },
    });
    expect(() =>
      loadPlatformAuthRuntimeConfig({
        ...environment,
        WISER_AGENT_AUTH_ISSUER: 'http://auth.example.test/auth/v1',
      }),
    ).toThrow('Agent');
  });

  it('requires the Supabase and database configuration in production', () => {
    expect(() =>
      loadPlatformAuthRuntimeConfig({ NODE_ENV: 'production' }),
    ).toThrow('SUPABASE_URL');
    expect(() =>
      loadPlatformAuthRuntimeConfig({
        NODE_ENV: 'production',
        WISER_AUTH_MODE: 'off',
      }),
    ).toThrow('WISER_AUTH_MODE=off is forbidden in production');
    expect(() =>
      loadPlatformAuthRuntimeConfig({
        NODE_ENV: 'production',
        SUPABASE_URL: 'http://127.0.0.1:56321',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
      }),
    ).toThrow('WISER_DELEGATED_CREDENTIAL_HMAC_KEYS');
  });

  it('keeps the platform identity module opt-in for local compatibility', () => {
    expect(
      createPlatformAuthModuleFromEnvironment({ NODE_ENV: 'development' }),
    ).toBeNull();
    expect(
      createPlatformAuthRuntimeFromEnvironment({ NODE_ENV: 'development' }),
    ).toEqual({ module: null, resolver: null });
  });

  it('exposes the same fail-closed resolver to sibling system transports', async () => {
    const claimsClient: SupabaseClaimsClient = {
      getClaims: vi.fn(() =>
        Promise.resolve({
          data: {
            claims: {
              sub: USER_ID,
              session_id: SESSION_ID,
              role: 'authenticated',
              exp: 1_800_000_000,
            },
          },
          error: null,
        }),
      ),
    };
    const query: AuthorizationQuery = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            tenant_id: TENANT_ID,
            project_id: PROJECT_ID,
            roles: ['data-reader'],
            scopes: ['data.catalog.read'],
            max_security_level: 'L1_INTERNAL',
            authz_version: 2,
          },
        ],
      }),
    );
    const factories: PlatformAuthRuntimeFactories = {
      createClaimsClient: vi.fn(() => claimsClient),
      createAuthorizationDatabase: vi.fn(() => ({
        query,
        delegatedCredentialQuery: vi.fn(() => Promise.resolve({ rows: [] })),
        transactionPool: {
          connect: vi.fn(() =>
            Promise.reject(new Error('transaction pool was not expected')),
          ),
        },
        close: vi.fn(() => Promise.resolve()),
      })),
    };

    const runtime = createPlatformAuthRuntimeFromEnvironment(
      {
        NODE_ENV: 'test',
        WISER_AUTH_MODE: 'supabase',
        SUPABASE_URL: 'http://127.0.0.1:56321',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
        WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
          activeKeyId: 'primary-2026-08',
          keys: {
            'primary-2026-08': Buffer.alloc(32, 7).toString('base64url'),
          },
        }),
      },
      factories,
    );

    expect(runtime.module).not.toBeNull();
    await expect(
      runtime.resolver?.resolve({
        token: 'verified-token',
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        purpose: 'operate',
        traceId: 'f1000000000040008000000000000005',
      }),
    ).resolves.toMatchObject({
      principal: { actorId: USER_ID },
      authorization: {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        scopes: ['data.catalog.read'],
      },
    });
  });

  it('loads resource authority on every verified resolution and fails closed on authority loss', async () => {
    const snapshot = {
      mode: 'managed',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      actorId: USER_ID,
      purpose: 'operate',
      now: '2026-09-23T00:00:00Z',
      revision: 3,
      grants: [],
    };
    const resourceAuthorityQuery = vi.fn(
      (): Promise<{ rows: { snapshot: unknown }[] }> =>
        Promise.resolve({ rows: [{ snapshot }] }),
    );
    const factories = {
      createClaimsClient: () => ({
        getClaims: () =>
          Promise.resolve({
            data: {
              claims: {
                sub: USER_ID,
                session_id: SESSION_ID,
                role: 'authenticated',
                exp: 1_800_000_000,
              },
            },
            error: null,
          }),
      }),
      createAuthorizationDatabase: () => ({
        query: () =>
          Promise.resolve({
            rows: [
              {
                tenant_id: TENANT_ID,
                project_id: PROJECT_ID,
                roles: ['data-reader'],
                scopes: ['data.catalog.read'],
                max_security_level: 'L1_INTERNAL',
                authz_version: 2,
              },
            ],
          }),
        delegatedCredentialQuery: () => Promise.resolve({ rows: [] }),
        resourceAuthorityQuery,
        transactionPool: {
          connect: () => Promise.reject(new Error('No transaction expected')),
        },
        close: () => Promise.resolve(),
      }),
    };
    const runtime = createPlatformAuthRuntimeFromEnvironment(
      {
        WISER_AUTH_MODE: 'supabase',
        SUPABASE_URL: 'http://127.0.0.1:56521',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:56522/postgres',
        WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
          activeKeyId: 'test',
          keys: { test: Buffer.alloc(32, 7).toString('base64url') },
        }),
      },
      factories,
    );
    const input = {
      token: 'verified-token',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      purpose: 'operate',
      traceId: 'f'.repeat(32),
    };
    const first = await runtime.resolver!.resolve(input);
    expect(first?.authorization.resourceAccess).toMatchObject({
      revision: 3,
      scope: { mode: 'managed', permissions: { 'content.read': [] } },
    });
    resourceAuthorityQuery.mockResolvedValue({
      rows: [{ snapshot: { ...snapshot, revision: 4 } }],
    });
    const next = await runtime.resolver!.resolve(input);
    expect(next?.authorization.resourceAccess?.revision).toBe(4);
    expect(next?.authorization.resourceAccess?.fingerprint).not.toBe(
      first?.authorization.resourceAccess?.fingerprint,
    );
    resourceAuthorityQuery.mockRejectedValue(
      new Error('private database details'),
    );
    await expect(runtime.resolver!.resolve(input)).resolves.toBeNull();
    expect(resourceAuthorityQuery).toHaveBeenCalledTimes(3);
  });

  it('wires verified claims membership lookup and pool shutdown', async () => {
    const claimsClient: SupabaseClaimsClient = {
      getClaims: vi.fn(() =>
        Promise.resolve({
          data: {
            claims: {
              sub: USER_ID,
              session_id: SESSION_ID,
              role: 'authenticated',
              exp: 1_800_000_000,
            },
          },
          error: null,
        }),
      ),
    };
    const query: AuthorizationQuery = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            tenant_id: TENANT_ID,
            project_id: PROJECT_ID,
            roles: ['data-reader'],
            scopes: ['data.catalog.read'],
            max_security_level: 'L1_INTERNAL',
            authz_version: 2,
          },
        ],
      }),
    );
    const close = vi.fn(() => Promise.resolve());
    const delegatedCredentialQuery: DelegatedCredentialAuthorizationQuery =
      vi.fn(() => Promise.resolve({ rows: [] }));
    const transactionPool: PlatformDelegationTransactionPool = {
      connect: vi.fn(() =>
        Promise.reject(new Error('transaction pool was not expected')),
      ),
    };
    const factories: PlatformAuthRuntimeFactories = {
      createClaimsClient: vi.fn(() => claimsClient),
      createAuthorizationDatabase: vi.fn(() => ({
        query,
        delegatedCredentialQuery,
        transactionPool,
        close,
      })),
    };
    const module = createPlatformAuthModuleFromEnvironment(
      {
        NODE_ENV: 'test',
        WISER_AUTH_MODE: 'supabase',
        SUPABASE_URL: 'http://127.0.0.1:56321',
        SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key-long-enough',
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:56322/postgres',
        WISER_DELEGATED_CREDENTIAL_HMAC_KEYS: JSON.stringify({
          activeKeyId: 'primary-2026-08',
          keys: {
            'primary-2026-08': Buffer.alloc(32, 7).toString('base64url'),
          },
        }),
      },
      factories,
    );
    expect(module).not.toBeNull();
    const app = buildApp({ modules: module === null ? [] : [module] });
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/platform/v1/me',
      headers: {
        authorization: 'Bearer verified-token',
        'x-wiser-tenant-id': TENANT_ID,
        'x-wiser-project-id': PROJECT_ID,
        'x-wiser-purpose': 'operate',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      actorId: USER_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      maxSecurityLevel: 'L1_INTERNAL',
    });

    await app.close();
    openApps.pop();
    expect(close).toHaveBeenCalledOnce();
  });
});
