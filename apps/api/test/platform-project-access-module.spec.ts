import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ProjectAccessError } from '@wiser/platform-auth';
import {
  createProjectAccessModule,
  type ProjectAccessHttpService,
} from '../src/platform/project-access-module.js';
const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});
const projectId = randomUUID();
const member = {
  actorId: randomUUID(),
  displayName: 'Reader',
  email: 'reader@example.test',
  status: 'active',
  version: 1,
  expiresAt: null,
  protected: false,
  roles: [],
};
function fixture() {
  const service = {
    invitations: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
    invite: vi.fn(() => Promise.reject(new Error('Not used'))),
    deliverInvitation: vi.fn(() => Promise.reject(new Error('Not used'))),
    projects: vi.fn(() => Promise.resolve({ items: [], hasMore: false })),
    members: vi.fn(() => Promise.resolve({ items: [member], hasMore: false })),
    grant: vi.fn(() => Promise.resolve(member)),
    revoke: vi.fn(() => Promise.resolve(member)),
  } satisfies ProjectAccessHttpService;
  const app = Fastify({ logger: false });
  void createProjectAccessModule(service).register(app);
  open.push(app);
  return { app, service };
}
const auth = { authorization: 'Bearer human-session' };
const command = {
  projectId,
  actorId: member.actorId,
  roleKey: 'data-reader',
  expiresAt: '2027-01-01T00:00:00Z',
  reason: 'Read the approved sample.',
  expectedVersion: 0,
};
describe('Project access HTTP boundary', () => {
  it('serializes only declared member fields', async () => {
    const { app, service } = fixture();
    const extended = { ...member, privateNote: 'must stay private' };
    service.members.mockResolvedValue({ items: [extended], hasMore: false });
    const response = await app.inject({
      url: `/api/platform/v1/access/projects/${projectId}/members`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('privateNote');
    expect(response.json<{ items: unknown[] }>().items[0]).toEqual(member);
  });

  it('requires a human bearer token and bounds pagination before invoking the service', async () => {
    const { app, service } = fixture();
    expect(
      (await app.inject('/api/platform/v1/access/projects')).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/platform/v1/access/projects?limit=500',
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
    expect(service.projects).not.toHaveBeenCalled();
    const response = await app.inject({
      url: '/api/platform/v1/access/projects',
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(service.projects).toHaveBeenCalledWith({
      token: 'human-session',
      page: { offset: 0, limit: 20, search: '' },
    });
  });
  it('forwards only a validated command with a required idempotency key', async () => {
    const { app, service } = fixture();
    const url = '/api/platform/v1/access/grants';
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: auth,
          payload: command,
        })
      ).statusCode,
    ).toBe(400);
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { ...command, scope: '*' },
        })
      ).statusCode,
    ).toBe(400);
    expect(service.grant).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: command }))
        .statusCode,
    ).toBe(200);
    expect(service.grant).toHaveBeenCalledWith({
      token: 'human-session',
      idempotencyKey: headers['idempotency-key'],
      command,
    });
  });
  it('keeps the project boundary on member queries and returns stable denials without private details', async () => {
    const { app, service } = fixture();
    service.members.mockRejectedValue(new ProjectAccessError('NOT_AUTHORIZED'));
    const response = await app.inject({
      url: `/api/platform/v1/access/projects/${projectId}/members?search=Reader`,
      headers: auth,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'NOT_AUTHORIZED' });
    expect(service.members).toHaveBeenCalledWith({
      token: 'human-session',
      projectId,
      page: { offset: 0, limit: 20, search: 'Reader' },
    });
  });
  it('does not disclose unexpected database or provider errors', async () => {
    const { app, service } = fixture();
    service.projects.mockRejectedValue(new Error('private connection detail'));
    const response = await app.inject({
      url: '/api/platform/v1/access/projects',
      headers: auth,
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private connection');
    expect(response.json()).toEqual({ code: 'ACCESS_UNAVAILABLE' });
  });
  it('reports stale mutations as conflicts rather than successful revocations', async () => {
    const { app, service } = fixture();
    service.revoke.mockRejectedValue(
      new ProjectAccessError('VERSION_CONFLICT'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/platform/v1/access/revocations',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: {
        projectId,
        actorId: member.actorId,
        reason: 'Review complete.',
        expectedVersion: 1,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers['cache-control']).toContain('no-store');
  });
});
