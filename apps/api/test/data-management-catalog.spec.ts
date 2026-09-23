import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { assertResourceManagementPolicy } from '@wiser/platform-auth';
import { createDataManagementCatalogReader } from '../src/data-foundation/management-catalog.js';

function fixture() {
  const projectId = randomUUID(),
    actorId = randomUUID();
  const context = {
    principal: {
      actorType: 'human' as const,
      actorId,
      authUserId: actorId,
      sessionId: randomUUID(),
      authenticationMethod: 'supabase_jwt' as const,
    },
    traceId: 'a'.repeat(32),
    authorization: {
      tenantId: randomUUID(),
      projectId,
      purpose: 'web-console' as const,
      maxSecurityLevel: 'L1_INTERNAL' as const,
      roles: ['source-steward'],
      scopes: ['platform.membership.manage'],
      authzVersion: 1,
    },
  };
  const query = vi.fn((sql: string) =>
    Promise.resolve({
      rows: sql.includes('management-catalog.list')
        ? [
            {
              data_item_id: randomUUID(),
              version_id: randomUUID(),
              name: 'Synthetic river source',
              source_organization: 'Synthetic provider',
              version_number: '1',
              security_level: 'L1_INTERNAL',
              processing_stage: 'RAW',
              publication_status: 'PUBLISHED',
              acceptance_status: 'PASSED',
            },
          ]
        : [],
    }),
  );
  const release = vi.fn(),
    connect = vi.fn(() => Promise.resolve({ query, release }));
  const read = createDataManagementCatalogReader({ connect });
  const page = { offset: 0, limit: 20, search: 'river' };
  const permit = () =>
    assertResourceManagementPolicy(
      {
        context,
        client: {
          release() {},
          query: <Row>() =>
            Promise.resolve({
              rows: [
                {
                  snapshot: {
                    mode: 'managed',
                    tenantId: context.authorization.tenantId,
                    projectId: context.authorization.projectId,
                    actorId,
                    purpose: context.authorization.purpose,
                    now: new Date().toISOString(),
                    revision: 1,
                    grants: [],
                    limits: [],
                  },
                },
              ] as Row[],
              rowCount: 1,
            }),
        },
      },
      [],
      [],
    );
  return { context, read, page, permit, query, connect, release };
}

describe('separately appointed management metadata catalog', () => {
  it('requires one live, context-bound permit before opening Data', async () => {
    const f = fixture();
    await expect(
      f.read({
        context: f.context,
        page: f.page,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
    const permit = await f.permit();
    await expect(
      f.read({
        context: {
          ...f.context,
          authorization: {
            ...f.context.authorization,
            projectId: randomUUID(),
          },
        },
        page: f.page,
        signal: new AbortController().signal,
        managementPermit: permit,
      }),
    ).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('uses a private read-only metadata role and returns whitelisted columns only', async () => {
    const f = fixture(),
      permit = await f.permit();
    const page = await f.read({
      context: f.context,
      page: f.page,
      signal: new AbortController().signal,
      managementPermit: permit,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ name: 'Synthetic river source' });
    expect(page.items[0]).not.toHaveProperty('assetManifest');
    expect(page.items[0]).not.toHaveProperty('sourceContact');
    const statements = f.query.mock.calls.map(([sql]) => sql.toLowerCase());
    expect(statements).toContain('begin read only');
    expect(statements).toContain('set local role wiser_data_metadata');
    expect(
      statements.some((sql) =>
        sql.includes("set_config('wiser.resource_scope','',true)"),
      ),
    ).toBe(true);
    expect(statements.join('\n')).toContain(
      'length(trim(i.authorization_scope))>0',
    );
    expect(statements.join('\n')).not.toMatch(
      /catalog\.asset|knowledge\.evidence_fragment/,
    );
    expect(f.release).toHaveBeenCalledOnce();
    await expect(
      f.read({
        context: f.context,
        page: f.page,
        signal: new AbortController().signal,
        managementPermit: permit,
      }),
    ).rejects.toThrow();
  });
});
