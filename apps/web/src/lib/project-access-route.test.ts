import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const client = {
  batches: vi.fn(),
  previewBatch: vi.fn(),
  projects: vi.fn(),
  members: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  definitions: vi.fn(),
  savePreset: vi.fn(),
};
vi.mock('./project-access.server', () => ({
  getProjectAccessClient: () => client,
  ProjectAccessWebError: class extends Error {},
}));
import { POST, GET } from '../app/api/platform/access/[action]/route';
const context = (action: string) => ({ params: Promise.resolve({ action }) });
it('forwards bounded resource definitions and preserves the fixed preset version', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  client.definitions.mockResolvedValue({
    items: [],
    hasMore: false,
    authorityRevision: 1,
  });
  expect(
    (
      await GET(
        new Request(
          `http://wiser.test/api/platform/access/resource-definitions?projectId=${projectId}&kind=preset`,
        ),
        context('resource-definitions'),
      )
    ).status,
  ).toBe(200);
  expect(client.definitions).toHaveBeenCalledWith(projectId, {
    kind: 'preset',
    offset: 0,
    limit: 20,
    search: '',
  });
  client.savePreset.mockResolvedValue({
    kind: 'preset',
    id: projectId,
    version: 1,
    authorityRevision: 1,
  });
  const command = {
    projectId,
    presetId: projectId,
    expectedVersion: 0,
    name: 'Read',
    actions: ['content.read'],
    maxDays: 30,
    approvalLevel: 'ordinary',
    reason: 'Approved research',
  };
  const response = await POST(
    new Request('http://wiser.test/api/platform/access/resource-preset', {
      method: 'POST',
      headers: {
        origin: 'http://wiser.test',
        host: 'wiser.test',
        'content-type': 'application/json',
        'idempotency-key': projectId,
      },
      body: JSON.stringify(command),
    }),
    context('resource-preset'),
  );
  expect(response.status).toBe(200);
  expect(client.savePreset).toHaveBeenCalledWith(command, projectId);
});
it('rejects a cross-origin mutation before forwarding any identity or command', async () => {
  const response = await POST(
    new Request('http://wiser.test/api/platform/access/grant', {
      method: 'POST',
      headers: {
        origin: 'https://outside.test',
        host: 'wiser.test',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
    context('grant'),
  );
  expect(response.status).toBe(403);
  expect(client.grant).not.toHaveBeenCalled();
});
it('rejects unknown actions, oversized bodies and query impersonation', async () => {
  expect(
    (
      await GET(
        new Request('http://wiser.test/api/platform/access/other'),
        context('other'),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await GET(
        new Request(
          'http://wiser.test/api/platform/access/projects?token=caller',
        ),
        context('projects'),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await POST(
        new Request('http://wiser.test/api/platform/access/grant', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'x'.repeat(16385),
        }),
        context('grant'),
      )
    ).status,
  ).toBe(413);
  expect(client.projects).not.toHaveBeenCalled();
  expect(client.grant).not.toHaveBeenCalled();
});
it('returns only the authenticated service result with cache disabled', async () => {
  client.projects.mockResolvedValue({ items: [], hasMore: false });
  const response = await GET(
    new Request('http://wiser.test/api/platform/access/projects'),
    context('projects'),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({ items: [], hasMore: false });
});

it('forwards bounded batch browsing and preview only through the verified server client', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  client.batches.mockResolvedValue({ items: [], hasMore: false });
  const response = await GET(
    new Request(
      `http://wiser.test/api/platform/access/resource-batches?projectId=${projectId}&status=pending`,
    ),
    context('resource-batches'),
  );
  expect(response.status).toBe(200);
  expect(client.batches).toHaveBeenCalledWith(projectId, {
    offset: 0,
    limit: 20,
    status: 'pending',
  });
  const command = {
    projectId,
    packageId: projectId,
    packageVersion: 1,
    presetId: projectId,
    presetVersion: 1,
    actorIds: [projectId],
    purpose: 'web-console',
    startsAt: '2026-09-23T00:00:00Z',
    expiresAt: '2026-09-24T00:00:00Z',
    reason: 'Prepare resource preview',
  };
  client.previewBatch.mockResolvedValue({ status: 'pending' });
  const req = new Request(
    'http://wiser.test/api/platform/access/resource-batch-preview',
    {
      method: 'POST',
      headers: {
        origin: 'http://wiser.test',
        host: 'wiser.test',
        'content-type': 'application/json',
        'idempotency-key': projectId,
      },
      body: JSON.stringify(command),
    },
  );
  expect((await POST(req, context('resource-batch-preview'))).status).toBe(200);
  expect(client.previewBatch).toHaveBeenCalledWith(command, projectId);
});
