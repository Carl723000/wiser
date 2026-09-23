import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceAdministrationError } from '@wiser/platform-auth';
import { createResourceAdministrationModule } from '../src/platform/resource-administration-module.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const project = randomUUID();
const auth = { authorization: 'Bearer verified-human' };
const command = {
  projectId: project,
  presetId: randomUUID(),
  expectedVersion: 0,
  name: 'Research reading',
  actions: ['content.read'],
  maxDays: 30,
  approvalLevel: 'ordinary',
  reason: 'Permitted research reading',
};
function fixture() {
  const batch = {
    id: randomUUID(),
    projectId: project,
    version: 1,
    status: 'pending' as const,
    packageId: randomUUID(),
    packageVersion: 1,
    packageName: 'Research resources',
    presetId: command.presetId,
    presetVersion: 1,
    presetName: command.name,
    resourceCount: 1,
    actions: ['content.read' as const],
    approvalLevel: 'ordinary' as const,
    purpose: 'web-console' as const,
    startsAt: '2026-09-23T00:00:00Z',
    expiresAt: '2026-09-24T00:00:00Z',
    validUntil: '2026-09-23T00:15:00Z',
    applicantId: randomUUID(),
    decidedBy: null,
    reason: command.reason,
    decisionReason: null,
    members: [
      {
        actorId: randomUUID(),
        displayName: 'Reader',
        membershipVersion: 1,
        existingGrantCount: 0,
        diff: null,
        status: 'pending' as const,
        grantId: null,
        code: null,
        attempts: 0,
      },
    ],
  };
  const sourcePolicy = {
    id: randomUUID(),
    projectId: project,
    policyId: randomUUID(),
    expectedPolicyVersion: 0,
    resource: {
      kind: 'version' as const,
      dataItemId: randomUUID(),
      versionId: randomUUID(),
    },
    allowedActions: ['content.read' as const],
    managementRoles: ['platform-owner'],
    licenseBasis: 'Synthetic source evidence',
    startsAt: '2026-09-23T00:00:00Z',
    expiresAt: '2026-10-23T00:00:00Z',
    maxGrantDays: 10,
    reason: 'Synthetic proposal reason',
    applicantId: randomUUID(),
    status: 'pending' as const,
    version: 1,
    decidedBy: null,
    decisionReason: null,
    publishedVersion: null,
    createdAt: '2026-09-23T00:00:00Z',
    decidedAt: null,
  };
  const service = {
    managementCatalog: vi.fn(() =>
      Promise.resolve({
        items: [],
        hasMore: false,
        checkedAt: '2026-09-23T00:00:00Z',
        managementRoleOptions: [],
      }),
    ),
    sourcePolicyRequests: vi.fn(() =>
      Promise.resolve({
        items: [{ ...sourcePolicy, publicationState: 'none' as const }],
        checkedAt: '2026-09-23T00:00:00Z',
        hasMore: false,
        canPropose: true,
        canApprove: false,
      }),
    ),
    proposeSourcePolicy: vi.fn(() => Promise.resolve(sourcePolicy)),
    decideSourcePolicy: vi.fn(() => Promise.resolve(sourcePolicy)),
    withdrawSourcePolicy: vi.fn(() => Promise.resolve(sourcePolicy)),
    revokeSourcePolicy: vi.fn(() =>
      Promise.resolve({
        policyId: sourcePolicy.policyId,
        policyVersion: 1,
        status: 'revoked' as const,
      }),
    ),
    grants: vi.fn(() =>
      Promise.resolve({
        items: [],
        hasMore: false,
        checkedAt: '2026-09-23T00:00:00Z',
      }),
    ),
    revokeGrant: vi.fn(() =>
      Promise.resolve({
        grantId: project,
        revokedAt: '2026-09-23T00:00:00Z',
        alreadyRevoked: false,
        otherActiveGrantCount: 1,
      }),
    ),
    renewGrant: vi.fn(() =>
      Promise.resolve({ previousGrantId: project, batch }),
    ),
    batches: vi.fn(() => Promise.resolve({ items: [batch], hasMore: false })),
    previewBatch: vi.fn(() => Promise.resolve(batch)),
    decideBatch: vi.fn(() => Promise.resolve(batch)),
    executeBatch: vi.fn(() => Promise.resolve(batch)),
    withdrawBatch: vi.fn(() => Promise.resolve(batch)),
    definitions: vi.fn(() =>
      Promise.resolve({
        items: [],
        hasMore: false,
        authorityRevision: 1,
      }),
    ),
    savePreset: vi.fn(() =>
      Promise.resolve({
        kind: 'preset' as const,
        id: command.presetId,
        version: 1,
        authorityRevision: 1,
      }),
    ),
    savePackage: vi.fn(() =>
      Promise.resolve({
        kind: 'package' as const,
        id: randomUUID(),
        version: 1,
        authorityRevision: 1,
      }),
    ),
  };
  const app = Fastify({ logger: false });
  void createResourceAdministrationModule(service).register(app);
  apps.push(app);
  return { app, service, batch, sourcePolicy };
}
describe('resource administration HTTP boundary', () => {
  it('requires a human token and bounded query for the private management catalog', async () => {
    const { app, service } = fixture();
    const url = `/api/platform/v1/access/projects/${project}/management-catalog`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `${url}?limit=21`, headers: auth })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `${url}?unexpected=true`, headers: auth })).statusCode,
    ).toBe(400);
    expect(service.managementCatalog).not.toHaveBeenCalled();
    const response = await app.inject({
      url: `${url}?search=river&offset=1&limit=10`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(service.managementCatalog).toHaveBeenCalledWith({
      token: 'verified-human',
      projectId: project,
      page: { offset: 1, limit: 10, search: 'river' },
    });
  });
  it('requires a bearer token and bounds definition listings', async () => {
    const { app, service } = fixture();
    const url = `/api/platform/v1/access/projects/${project}/resource-definitions?kind=package`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: url + '&limit=21', headers: auth })).statusCode,
    ).toBe(400);
    expect(service.definitions).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(service.definitions).toHaveBeenCalledWith({
      token: 'verified-human',
      projectId: project,
      page: { kind: 'package', offset: 0, limit: 20, search: '' },
    });
  });
  it('rejects extra policy fields and absent idempotency before creating definitions', async () => {
    const { app, service } = fixture();
    const url = '/api/platform/v1/access/resource-presets';
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
          payload: { ...command, approved: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(service.savePreset).not.toHaveBeenCalled();
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: command,
    });
    expect(response.statusCode).toBe(200);
    expect(service.savePreset).toHaveBeenCalledWith({
      token: 'verified-human',
      idempotencyKey: headers['idempotency-key'],
      command,
    });
  });
  it('keeps unknown errors private and distinguishes optimistic conflicts', async () => {
    const { app, service } = fixture();
    const request = {
      method: 'POST' as const,
      url: '/api/platform/v1/access/resource-presets',
      headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: command,
    };
    service.savePreset.mockRejectedValueOnce(
      new ResourceAdministrationError('VERSION_CONFLICT'),
    );
    expect((await app.inject(request)).statusCode).toBe(409);
    service.savePreset.mockRejectedValueOnce(
      new Error('postgres://private-secret'),
    );
    const response = await app.inject(request);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-secret');
  });
  it('lists bounded batch previews with no-store and no client-selected actor authority', async () => {
    const { app, service } = fixture();
    const url = `/api/platform/v1/access/projects/${project}/resource-batches`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: url + '?limit=21', headers: auth })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: url + '?actorId=' + randomUUID(),
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
    expect(service.batches).not.toHaveBeenCalled();
    const result = await app.inject({ url, headers: auth });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
  });
  it.each(['preview', 'decide', 'execute', 'withdraw'] as const)(
    'validates the %s batch action and retains safe failure codes',
    async (action) => {
      const { app, service, batch } = fixture();
      const payload =
        action === 'preview'
          ? {
              projectId: project,
              packageId: batch.packageId,
              packageVersion: 1,
              presetId: batch.presetId,
              presetVersion: 1,
              actorIds: batch.members.map((m) => m.actorId),
              purpose: 'web-console',
              startsAt: batch.startsAt,
              expiresAt: batch.expiresAt,
              reason: command.reason,
            }
          : {
              projectId: project,
              batchId: batch.id,
              expectedVersion: 1,
              reason: command.reason,
              ...(action === 'decide' ? { decision: 'approve' } : {}),
            };
      const url = '/api/platform/v1/access/resource-batches/' + action;
      const headers = { ...auth, 'idempotency-key': randomUUID() };
      expect(
        (await app.inject({ method: 'POST', url, headers: auth, payload }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...payload, approvedBy: randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'POST', url, headers, payload }))
          .statusCode,
      ).toBe(200);
      const method =
        action === 'preview'
          ? service.previewBatch
          : action === 'decide'
            ? service.decideBatch
            : action === 'execute'
              ? service.executeBatch
              : service.withdrawBatch;
      expect(method).toHaveBeenCalledWith({
        token: 'verified-human',
        idempotencyKey: headers['idempotency-key'],
        command: payload,
      });
      method.mockRejectedValueOnce(
        new ResourceAdministrationError('PREVIEW_EXPIRED'),
      );
      const expired = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(expired.statusCode).toBe(409);
      expect(expired.json()).toEqual({ code: 'PREVIEW_EXPIRED' });
    },
  );
});

it('serves own grant records and validates lifecycle commands with non-cacheable receipts', async () => {
  const { app, service } = fixture();
  const url = `/api/platform/v1/access/projects/${project}/resource-grants?limit=20`;
  expect((await app.inject({ url })).statusCode).toBe(401);
  const listed = await app.inject({ url, headers: auth });
  expect(listed.statusCode).toBe(200);
  expect(listed.headers['cache-control']).toContain('no-store');
  expect(service.grants).toHaveBeenCalledWith({
    token: 'verified-human',
    projectId: project,
    page: { offset: 0, limit: 20 },
  });
  expect(
    (await app.inject({ url: url + '&actorId=bad', headers: auth })).statusCode,
  ).toBe(400);
  for (const action of ['revoke', 'renew']) {
    const body = {
      projectId: project,
      grantId: project,
      reason: 'Scoped permission change',
      ...(action === 'renew' ? { expiresAt: '2026-10-01T00:00:00Z' } : {}),
    };
    const target = '/api/platform/v1/access/resource-grants/' + action;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: target,
          headers: auth,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    const receipt = await app.inject({
      method: 'POST',
      url: target,
      headers: { ...auth, 'idempotency-key': project },
      payload: body,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers['cache-control']).toContain('no-store');
    expect(
      action === 'renew'
        ? receipt.json<{ batch: { status: string } }>().batch.status
        : receipt.json<{ otherActiveGrantCount: number }>()
            .otherActiveGrantCount,
    ).toBe(action === 'renew' ? 'pending' : 1);
  }
});

describe('source permission HTTP boundary', () => {
  it('bounds the source proposal queue and rejects browser-selected actor authority', async () => {
    const { app, service } = fixture(),
      url = `/api/platform/v1/access/projects/${project}/source-policy-requests`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    for (const query of ['limit=21', 'actorId=' + randomUUID()])
      expect(
        (await app.inject({ url: url + '?' + query, headers: auth }))
          .statusCode,
      ).toBe(400);
    expect(service.sourcePolicyRequests).not.toHaveBeenCalled();
    const response = await app.inject({ url, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).toMatchObject({
      canPropose: true,
      canApprove: false,
    });
  });
  it.each(['propose', 'decide', 'withdraw', 'revoke'] as const)(
    'protects source %s commands and output',
    async (action) => {
      const { app, service, sourcePolicy: p } = fixture();
      const payload =
        action === 'propose'
          ? {
              projectId: project,
              policyId: p.policyId,
              expectedPolicyVersion: 0,
              resource: p.resource,
              allowedActions: p.allowedActions,
              managementRoles: p.managementRoles,
              licenseBasis: p.licenseBasis,
              startsAt: p.startsAt,
              expiresAt: p.expiresAt,
              maxGrantDays: p.maxGrantDays,
              reason: p.reason,
            }
          : action === 'revoke'
            ? {
                projectId: project,
                policyId: p.policyId,
                policyVersion: 1,
                reason: p.reason,
              }
            : {
                projectId: project,
                requestId: p.id,
                expectedVersion: 1,
                reason: p.reason,
                ...(action === 'decide' ? { decision: 'publish' } : {}),
              };
      const url = '/api/platform/v1/access/source-policies/' + action;
      expect(
        (await app.inject({ method: 'POST', url, headers: auth, payload }))
          .statusCode,
      ).toBe(400);
      const headers = { ...auth, 'idempotency-key': randomUUID() };
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers,
            payload: { ...payload, approvedBy: p.applicantId },
          })
        ).statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      const fn =
        action === 'propose'
          ? service.proposeSourcePolicy
          : action === 'decide'
            ? service.decideSourcePolicy
            : action === 'withdraw'
              ? service.withdrawSourcePolicy
              : service.revokeSourcePolicy;
      expect(fn).toHaveBeenCalledTimes(1);
      fn.mockRejectedValueOnce(new Error('private storage detail'));
      const failure = await app.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(failure.statusCode).toBe(503);
      expect(failure.body).not.toContain('private storage detail');
    },
  );
});
