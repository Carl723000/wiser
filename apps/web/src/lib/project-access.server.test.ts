import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createProjectAccessClient } from './project-access.server';
const origin = 'http://api.test';
function address(value: Parameters<typeof globalThis.fetch>[0] | undefined) {
  return value instanceof URL
    ? value.href
    : value instanceof Request
      ? value.url
      : value;
}
describe('project access server transport', () => {
  it('uses only the freshly verified session and disables caching and redirects', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ items: [], hasMore: false }));
    const client = createProjectAccessClient({
      origin,
      token: () => Promise.resolve('current-session'),
      fetch,
    });
    expect(
      await client.projects({ offset: 0, limit: 20, search: '京津冀' }),
    ).toEqual({ items: [], hasMore: false });
    const [url, options] = fetch.mock.calls[0];
    expect(url instanceof URL ? url.href : url).toContain(
      '/api/platform/v1/access/projects?',
    );
    expect(options).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer current-session' },
    });
  });
  it('never falls back to a static credential if the session cannot be verified', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createProjectAccessClient({
      origin,
      token: () => Promise.reject(new Error('invalid session')),
      fetch,
    });
    await expect(
      client.projects({ offset: 0, limit: 20, search: '' }),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('redacts malformed upstream details and rejects oversized responses', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('private provider detail', { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response('x'.repeat(524289), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createProjectAccessClient({
      origin,
      token: () => Promise.resolve('current-session'),
      fetch,
    });
    for (let i = 0; i < 2; i++)
      await expect(
        client.projects({ offset: 0, limit: 20, search: '' }),
      ).rejects.toMatchObject({ message: 'ACCESS_UNAVAILABLE' });
  });
  it('rejects arbitrary upstream destinations and validates commands before sending', async () => {
    expect(() =>
      createProjectAccessClient({
        origin: 'file:///etc',
        token: () => Promise.resolve('x'),
      }),
    ).toThrow();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createProjectAccessClient({
      origin,
      token: () => Promise.resolve('x'),
      fetch,
    });
    await expect(
      client.members('outside', { offset: 0, limit: 20, search: '' }),
    ).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('transports versioned resource definitions through the verified session only', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ items: [], hasMore: false, authorityRevision: 1 }),
    )
    .mockResolvedValueOnce(
      Response.json({ kind: 'package', id, version: 1, authorityRevision: 2 }),
    )
    .mockResolvedValueOnce(
      Response.json({ kind: 'preset', id, version: 1, authorityRevision: 3 }),
    );
  const client = createProjectAccessClient({
    origin,
    token: () => Promise.resolve('verified'),
    fetch,
  });
  await client.definitions(id, {
    kind: 'package',
    offset: 0,
    limit: 20,
    search: 'A&B',
  });
  await client.savePackage(
    {
      projectId: id,
      packageId: id,
      expectedVersion: 0,
      name: 'Research',
      resources: [{ kind: 'version', dataItemId: id, versionId: id }],
      allowedActions: ['content.read'],
      licenseBasis: 'Public research license',
      reason: 'Research review',
    },
    id,
  );
  await client.savePreset(
    {
      projectId: id,
      presetId: id,
      expectedVersion: 0,
      name: 'Research',
      actions: ['content.read'],
      maxDays: 30,
      approvalLevel: 'ordinary',
      reason: 'Research review',
    },
    id,
  );
  expect(address(fetch.mock.calls[0]?.[0])).toContain('search=A%26B');
  expect(address(fetch.mock.calls[1]?.[0])).toContain(
    '/access/resource-packages',
  );
  expect(address(fetch.mock.calls[2]?.[0])).toContain(
    '/access/resource-presets',
  );
  for (const [, options] of fetch.mock.calls)
    expect(options).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer verified' },
    });
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'Idempotency-Key': id },
  });
});

it('sends bounded batch actions to their exact authenticated routes and preserves safe expiry errors', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        Response.json({ code: 'PREVIEW_EXPIRED' }, { status: 409 }),
      ),
    );
  const client = createProjectAccessClient({
    origin,
    token: () => Promise.resolve('verified'),
    fetch,
  });
  const action = {
    projectId: id,
    batchId: id,
    expectedVersion: 1,
    reason: 'Current scope review',
  };
  await expect(
    client.batches(id, { offset: 0, limit: 20, status: 'pending' }),
  ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED', status: 409 });
  await expect(
    client.previewBatch(
      {
        projectId: id,
        packageId: id,
        packageVersion: 1,
        presetId: id,
        presetVersion: 1,
        actorIds: [id],
        purpose: 'web-console',
        startsAt: '2026-09-23T00:00:00Z',
        expiresAt: '2026-09-24T00:00:00Z',
        reason: action.reason,
      },
      id,
    ),
  ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
  await expect(
    client.decideBatch({ ...action, decision: 'approve' }, id),
  ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
  await expect(client.executeBatch(action, id)).rejects.toMatchObject({
    code: 'PREVIEW_EXPIRED',
  });
  await expect(client.withdrawBatch(action, id)).rejects.toMatchObject({
    code: 'PREVIEW_EXPIRED',
  });
  const urls = fetch.mock.calls.map(([url]) => address(url));
  expect(urls[0]).toContain(
    `/projects/${id}/resource-batches?offset=0&limit=20&status=pending`,
  );
  for (const [index, verb] of [
    'preview',
    'decide',
    'execute',
    'withdraw',
  ].entries())
    expect(urls[index + 1]).toBe(
      `${origin}/api/platform/v1/access/resource-batches/${verb}`,
    );
  for (const [, options] of fetch.mock.calls)
    expect(options).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: { Authorization: 'Bearer verified' },
    });
});

it('routes resource lifecycle commands with the session identity, exact grant ID and idempotency key', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [],
        hasMore: false,
        checkedAt: '2026-09-23T00:00:00Z',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        grantId: id,
        revokedAt: '2026-09-23T00:00:00Z',
        alreadyRevoked: false,
        otherActiveGrantCount: 1,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: 'REQUEST_STATE_CONFLICT' }, { status: 409 }),
    );
  const client = createProjectAccessClient({
    origin,
    token: () => Promise.resolve('verified-session'),
    fetch,
  });
  await client.grants(id, {
    actorId: id,
    offset: 20,
    limit: 20,
    status: 'active',
  });
  expect(address(fetch.mock.calls[0][0])).toContain(
    `projects/${id}/resource-grants?offset=20&limit=20&actorId=${id}&status=active`,
  );
  const command = {
    projectId: id,
    grantId: id,
    reason: 'End scoped resource access',
  };
  await client.revokeGrant(command, id);
  await expect(
    client.renewGrant({ ...command, expiresAt: '2026-10-01T00:00:00Z' }, id),
  ).rejects.toMatchObject({ code: 'REQUEST_STATE_CONFLICT' });
  for (const [i, action] of [
    [1, 'revoke'],
    [2, 'renew'],
  ] as const) {
    expect(address(fetch.mock.calls[i][0])).toBe(
      `${origin}/api/platform/v1/access/resource-grants/${action}`,
    );
    expect(fetch.mock.calls[i][1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer verified-session',
        'Idempotency-Key': id,
      },
    });
  }
});

it('transports source stewardship with fresh identity, fixed versions and strict response validation', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      items: [],
      hasMore: false,
      canPropose: true,
      canApprove: false,
      checkedAt: '2026-09-23T00:00:00Z',
    }),
  );
  const client = createProjectAccessClient({
    origin,
    token: () => Promise.resolve('session'),
    fetch,
  });
  const page = await client.sourcePolicyRequests(id, {
    offset: 0,
    limit: 20,
    status: 'pending',
  });
  expect(page.canApprove).toBe(false);
  expect(address(fetch.mock.calls[0][0])).toContain(
    `/projects/${id}/source-policy-requests?`,
  );
  expect(fetch.mock.calls[0][1]).toMatchObject({
    cache: 'no-store',
    headers: { Authorization: 'Bearer session' },
  });
  const proposal = {
    projectId: id,
    policyId: id,
    expectedPolicyVersion: 0,
    resource: { kind: 'version' as const, dataItemId: id, versionId: id },
    allowedActions: ['content.read' as const],
    managementRoles: ['data-manager'],
    licenseBasis: 'Public redistribution permission',
    startsAt: '2026-09-23T00:00:00Z',
    expiresAt: '2026-10-23T00:00:00Z',
    maxGrantDays: 7,
    reason: 'Approved research scope',
  };
  const row = {
    ...proposal,
    id,
    applicantId: id,
    status: 'pending',
    version: 1,
    decidedBy: null,
    decisionReason: null,
    publishedVersion: null,
    createdAt: proposal.startsAt,
    decidedAt: null,
  };
  fetch.mockImplementation(() => Promise.resolve(Response.json(row)));
  await client.proposeSourcePolicy(proposal, id);
  const common = {
    projectId: id,
    requestId: id,
    expectedVersion: 1,
    reason: proposal.reason,
  };
  await client.decideSourcePolicy({ ...common, decision: 'reject' }, id);
  await client.withdrawSourcePolicy(common, id);
  fetch.mockImplementation(() =>
    Promise.resolve(
      Response.json({ policyId: id, policyVersion: 1, status: 'revoked' }),
    ),
  );
  await client.revokeSourcePolicy(
    { projectId: id, policyId: id, policyVersion: 1, reason: proposal.reason },
    id,
  );
  expect(
    fetch.mock.calls
      .slice(1)
      .map(([u]) => new URL(address(u) ?? '').pathname.split('/').at(-1)),
  ).toEqual(['propose', 'decide', 'withdraw', 'revoke']);
  for (const [, init] of fetch.mock.calls.slice(1))
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Idempotency-Key': id },
    });
  fetch.mockImplementation(() =>
    Promise.resolve(
      Response.json({ ...row, unexpectedCredential: 'never-render' }),
    ),
  );
  await expect(client.withdrawSourcePolicy(common, id)).rejects.toMatchObject({
    code: 'ACCESS_UNAVAILABLE',
  });
});
