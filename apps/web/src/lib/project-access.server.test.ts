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
