import { describe, expect, it, vi } from 'vitest';
import type {
  AuthorizedContext,
  ResourceAccessContext,
} from '@wiser/platform-contracts';
import { applyResourceReadScope } from '../src/data-foundation/resource-read-scope.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
const access: ResourceAccessContext = {
  revision: 1,
  fingerprint: 'a'.repeat(64),
  scope: {
    mode: 'managed',
    validUntil: '2099-01-01T00:00:00Z',
    permissions: {
      'content.read': [
        {
          kind: 'version',
          dataItemId: '11111111-1111-4111-8111-111111111111',
          versionId: '22222222-2222-4222-8222-222222222222',
        },
      ],
      'source.discover': [],
      'original.read': [],
      'result.export': [],
      'external.directory': [],
    },
  },
};
const authorization: AuthorizedContext = {
  tenantId: '33333333-3333-4333-8333-333333333333',
  projectId: '44444444-4444-4444-8444-444444444444',
  roles: ['data-reader'],
  scopes: ['data.catalog.read'],
  purpose: 'test-read',
  maxSecurityLevel: 'L1_INTERNAL',
  authzVersion: 1,
  resourceAccess: access,
};
describe('trusted resource read scope', () => {
  it.each(['content.read', 'original.read', 'result.export'] as const)(
    'installs bounded %s scope only in the current transaction',
    async (action) => {
      const query = vi.fn((_sql: string, _values?: readonly unknown[]) =>
        Promise.resolve({ rows: [] }),
      );
      await applyResourceReadScope({ query }, authorization, action);
      expect(query).toHaveBeenCalledOnce();
      const call = query.mock.calls[0]!;
      expect(call[0]).toContain("set_config('wiser.resource_scope',$1,true)");
      expect(JSON.parse(String(call[1]?.[0])) as unknown).toEqual(access.scope);
      expect(call[1]?.[1]).toBe(action);
      expect(call[1]).toHaveLength(2);
    },
  );
  it('keeps an unconfigured legacy transaction unchanged', async () => {
    const query = vi.fn((_sql: string, _values?: readonly unknown[]) =>
      Promise.resolve({ rows: [] }),
    );
    await applyResourceReadScope({ query }, {});
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects malformed managed authority rather than silently using legacy reads', async () => {
    const query = vi.fn((_sql: string, _values?: readonly unknown[]) =>
      Promise.resolve({ rows: [] }),
    );
    for (const invalid of [
      null,
      {},
      { ...access, scope: { mode: 'legacy' } },
      { ...access, fingerprint: 'bad' },
    ]) {
      await expect(
        applyResourceReadScope(
          { query },
          { resourceAccess: invalid as ResourceAccessContext },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects an expired compiled scope before any data query', async () => {
    const query = vi.fn((_sql: string, _values?: readonly unknown[]) =>
      Promise.resolve({ rows: [] }),
    );
    await expect(
      applyResourceReadScope(
        { query },
        {
          resourceAccess: {
            ...access,
            scope: {
              ...access.scope,
              mode: 'managed',
              permissions:
                access.scope.mode === 'managed'
                  ? access.scope.permissions
                  : ({} as never),
              validUntil: '2000-01-01T00:00:00Z',
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).not.toHaveBeenCalled();
  });
  it('propagates the authority scope through the real catalog executor', async () => {
    const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const client = {
      query: (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows: [] });
      },
      release: vi.fn(),
    };
    const runtime = createPostgresDataReadRuntime({
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    });
    const context: DataCapabilityExecutionContext = {
      principal: {
        actorId: '55555555-5555-4555-8555-555555555555',
        actorType: 'human',
        authenticationMethod: 'supabase_jwt',
      },
      authorization,
      effectiveMaxSecurityLevel: 'L1_INTERNAL',
      traceId: 'a'.repeat(32),
      auditLevel: 'STANDARD',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };
    await runtime.executors
      .find((e) => e.id === 'data.catalog.search')!
      .execute({ query: 'water', first: 10 }, context);
    const scopeIndex = calls.findIndex((c) =>
      c.sql.includes('wiser.resource_scope'),
    );
    expect(scopeIndex).toBeGreaterThan(0);
    expect(
      JSON.parse(String(calls[scopeIndex]?.values?.[0])) as unknown,
    ).toEqual(access.scope);
    expect(calls[scopeIndex]?.values?.[1]).toBe('content.read');
    expect(
      calls.slice(0, scopeIndex).some((c) => c.sql.includes('from catalog.')),
    ).toBe(false);
  });
});
