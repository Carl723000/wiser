import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  token: vi.fn(),
  request: vi.fn(),
  projects: vi.fn(),
  grants: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./supabase/server', () => ({
  createWiserServerSupabaseClient: mocks.createClient,
}));
vi.mock('./supabase/verified-session', () => ({
  verifiedSessionAccessToken: mocks.token,
}));
vi.mock('./agent-consent.server', () => ({
  agentPlatformRequest: mocks.request,
}));
vi.mock('./project-access.server', () => ({
  getProjectAccessClient: () => ({ projects: mocks.projects }),
}));
import { getAgentConnectionAccount } from './agent-connections.server';
const owned = {
  connectionId: randomUUID(),
  clientId: randomUUID(),
  delegationId: randomUUID(),
  tenantId: randomUUID(),
  projectId: randomUUID(),
  scopes: ['data.catalog.read'],
  purpose: 'agent-data',
  maxSecurityLevel: 'L1_INTERNAL',
  expiresAt: '2026-09-26T12:00:00Z',
  status: 'active',
};
const project = {
  projectId: owned.projectId,
  tenantId: owned.tenantId,
  nameZh: '河流',
  nameEn: 'River',
  memberStatus: 'active',
  expiresAt: '2099-09-26T12:00:00Z',
  roles: ['data-reader'],
};
beforeEach(() => {
  mocks.createClient.mockResolvedValue({
    auth: { oauth: { listGrants: mocks.grants, revokeGrant: mocks.revoke } },
  });
  mocks.token.mockResolvedValue('fresh-owner-session');
  mocks.request.mockResolvedValue({ connections: [owned] });
  mocks.grants.mockResolvedValue({
    data: [{ client: { id: owned.clientId, name: 'Client' } }],
    error: null,
  });
  mocks.revoke.mockResolvedValue({ error: null });
  mocks.projects.mockResolvedValue({
    items: [project],
    hasMore: false,
  });
});
it('finds a connected project beyond the first fifty and retains its current membership', async () => {
  mocks.projects
    .mockResolvedValueOnce({
      items: Array.from({ length: 50 }, () => ({
        ...project,
        projectId: randomUUID(),
      })),
      hasMore: true,
    })
    .mockResolvedValueOnce({ items: [project], hasMore: true });
  const view = await (await getAgentConnectionAccount()).load();
  expect(mocks.projects.mock.calls).toEqual([
    [{ offset: 0, limit: 50, search: '' }],
    [{ offset: 50, limit: 50, search: '' }],
  ]);
  expect(view[0]).toMatchObject({
    projectName: { 'zh-CN': '河流', en: 'River' },
    projectAccess: {
      state: 'loaded',
      memberStatus: 'active',
      expiresAt: project.expiresAt,
      roles: ['data-reader'],
    },
  });
});
it('distinguishes an exhausted visible list from a failed membership request', async () => {
  mocks.projects.mockResolvedValue({ items: [], hasMore: false });
  const account = await getAgentConnectionAccount();
  expect((await account.load())[0]?.projectAccess).toEqual({
    state: 'not-visible',
  });
  mocks.projects.mockRejectedValue(new Error('private upstream'));
  expect((await account.load())[0]?.projectAccess).toEqual({
    state: 'unavailable',
  });
  expect(await account.disconnect(owned.connectionId)).toBe('disconnected');
});
it('bounds project reads and keeps an unresolved page distinct from invisibility', async () => {
  mocks.projects.mockResolvedValue({
    items: Array.from({ length: 50 }, () => ({
      ...project,
      projectId: randomUUID(),
    })),
    hasMore: true,
  });
  expect(
    (await (await getAgentConnectionAccount()).load())[0]?.projectAccess,
  ).toEqual({ state: 'not-loaded' });
  expect(mocks.projects).toHaveBeenCalledTimes(10);
  expect(mocks.projects).toHaveBeenLastCalledWith({
    offset: 450,
    limit: 50,
    search: '',
  });
});
it('stops an empty continuing page without asserting invisibility', async () => {
  mocks.projects.mockResolvedValue({ items: [], hasMore: true });
  expect(
    (await (await getAgentConnectionAccount()).load())[0]?.projectAccess,
  ).toEqual({ state: 'not-loaded' });
  expect(mocks.projects).toHaveBeenCalledTimes(1);
});
it('does not reuse a project from another tenant or fetch projects for no connections', async () => {
  mocks.projects.mockResolvedValue({
    items: [{ ...project, tenantId: randomUUID() }],
    hasMore: false,
  });
  const account = await getAgentConnectionAccount();
  expect((await account.load())[0]?.projectAccess).toEqual({
    state: 'not-visible',
  });
  mocks.projects.mockClear();
  mocks.request.mockResolvedValue({ connections: [] });
  expect(await account.load()).toEqual([]);
  expect(mocks.projects).not.toHaveBeenCalled();
});
it('preserves already read conditions when a later page fails but rereads on the next load', async () => {
  const second = {
    ...owned,
    connectionId: randomUUID(),
    projectId: randomUUID(),
  };
  mocks.request.mockResolvedValue({ connections: [owned, second] });
  mocks.projects
    .mockResolvedValueOnce({ items: [project], hasMore: true })
    .mockRejectedValueOnce(new Error('private upstream'));
  const account = await getAgentConnectionAccount();
  const view = await account.load();
  expect(view[0]?.projectAccess).toMatchObject({ state: 'loaded' });
  expect(view[1]?.projectAccess).toEqual({ state: 'unavailable' });
  mocks.projects.mockResolvedValue({ items: [], hasMore: false });
  expect((await account.load()).map((item) => item.projectAccess)).toEqual([
    { state: 'not-visible' },
    { state: 'not-visible' },
  ]);
});
afterEach(() => vi.resetAllMocks());
it('never reads or revokes when the live user session cannot be verified', async () => {
  mocks.token.mockRejectedValue(new Error('invalid session'));
  await expect(getAgentConnectionAccount()).rejects.toThrow('invalid session');
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.revoke).not.toHaveBeenCalled();
});
it('allows disconnection after project visibility is lost and derives the provider client server-side', async () => {
  mocks.projects.mockRejectedValue(new Error('membership removed'));
  const account = await getAgentConnectionAccount();
  expect(await account.load()).toMatchObject([
    { clientName: 'Client', projectName: null, providerConsent: true },
  ]);
  expect(await account.disconnect(owned.connectionId)).toBe('disconnected');
  expect(mocks.request).toHaveBeenLastCalledWith(
    `/api/platform/v1/agent-connections/${owned.connectionId}/revoke`,
    'fresh-owner-session',
    'POST',
    {},
    expect.any(String),
  );
  expect(mocks.revoke).toHaveBeenCalledWith({ clientId: owned.clientId });
});
it('preserves project labels without returning auth tokens and does not hide provider failure', async () => {
  const account = await getAgentConnectionAccount();
  const view = await account.load();
  expect(view[0]?.projectName).toEqual({ 'zh-CN': '河流', en: 'River' });
  expect(JSON.stringify(view)).not.toContain('fresh-owner-session');
  mocks.grants.mockResolvedValue({ data: null, error: new Error('private') });
  await expect(account.load()).rejects.toThrow('unavailable');
});
