import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const client = {
  projects: vi.fn(),
  members: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
};
vi.mock('./project-access.server', () => ({
  getProjectAccessClient: () => client,
  ProjectAccessWebError: class extends Error {},
}));
import { POST, GET } from '../app/api/platform/access/[action]/route';
const context = (action: string) => ({ params: Promise.resolve({ action }) });
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
