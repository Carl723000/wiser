import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceAdministrationError } from '@wiser/platform-auth';
import { createResourceAdministrationModule } from '../src/platform/resource-administration-module.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const project = randomUUID();
const auth = { authorization: 'Bearer verified-human' };
const command = {
  projectId: project, presetId: randomUUID(), expectedVersion: 0,
  name: 'Research reading', actions: ['content.read'], maxDays: 30,
  approvalLevel: 'ordinary', reason: 'Permitted research reading',
};
function fixture() {
  const service = {
    definitions: vi.fn(async () => ({ items: [], hasMore: false, authorityRevision: 1 })),
    savePreset: vi.fn(async () => ({ kind: 'preset' as const, id: command.presetId, version: 1, authorityRevision: 1 })),
    savePackage: vi.fn(async () => ({ kind: 'package' as const, id: randomUUID(), version: 1, authorityRevision: 1 })),
  };
  const app = Fastify({ logger: false });
  createResourceAdministrationModule(service).register(app);
  apps.push(app);
  return { app, service };
}
describe('resource administration HTTP boundary', () => {
  it('requires a bearer token and bounds definition listings', async () => {
    const { app, service } = fixture();
    const url = `/api/platform/v1/access/projects/${project}/resource-definitions?kind=package`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url: url + '&limit=21', headers: auth })).statusCode).toBe(400);
    expect(service.definitions).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(service.definitions).toHaveBeenCalledWith({ token: 'verified-human', projectId: project, page: { kind: 'package', offset: 0, limit: 20, search: '' } });
  });
  it('rejects extra policy fields and absent idempotency before creating definitions', async () => {
    const { app, service } = fixture();
    const url = '/api/platform/v1/access/resource-presets';
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: command })).statusCode).toBe(400);
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...command, approved: true } })).statusCode).toBe(400);
    expect(service.savePreset).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url, headers, payload: command });
    expect(response.statusCode).toBe(200);
    expect(service.savePreset).toHaveBeenCalledWith({ token: 'verified-human', idempotencyKey: headers['idempotency-key'], command });
  });
  it('keeps unknown errors private and distinguishes optimistic conflicts', async () => {
    const { app, service } = fixture();
    const request = { method: 'POST' as const, url: '/api/platform/v1/access/resource-presets', headers: { ...auth, 'idempotency-key': randomUUID() }, payload: command };
    service.savePreset.mockRejectedValueOnce(new ResourceAdministrationError('VERSION_CONFLICT'));
    expect((await app.inject(request)).statusCode).toBe(409);
    service.savePreset.mockRejectedValueOnce(new Error('postgres://private-secret'));
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-secret');
  });
});
