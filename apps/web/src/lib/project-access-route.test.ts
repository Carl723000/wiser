import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const client = {
  sourcePolicyRequests: vi.fn(),
  proposeSourcePolicy: vi.fn(),
  decideSourcePolicy: vi.fn(),
  withdrawSourcePolicy: vi.fn(),
  revokeSourcePolicy: vi.fn(),
  grants: vi.fn(),
  revokeGrant: vi.fn(),
  renewGrant: vi.fn(),
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

it('bounds resource grant queries and protects revocation and renewal from cross-origin or forged bodies', async () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  client.grants.mockResolvedValue({
    items: [],
    hasMore: false,
    checkedAt: '2026-09-23T00:00:00Z',
  });
  const url = `http://wiser.test/api/platform/access/resource-grants?projectId=${projectId}`;
  expect((await GET(new Request(url), context('resource-grants'))).status).toBe(
    200,
  );
  expect(client.grants).toHaveBeenCalledWith(projectId, {
    offset: 0,
    limit: 20,
  });
  expect(
    (await GET(new Request(url + '&limit=21'), context('resource-grants')))
      .status,
  ).toBe(400);
  for (const action of ['revoke', 'renew']) {
    const target = 'resource-grant-' + action,
      command = {
        projectId,
        grantId: projectId,
        reason: 'End scoped grant',
        ...(action === 'renew' ? { expiresAt: '2026-10-01T00:00:00Z' } : {}),
      };
    const request = (origin: string, body: unknown) =>
      new Request('http://wiser.test/api/platform/access/' + target, {
        method: 'POST',
        headers: {
          origin,
          host: 'wiser.test',
          'content-type': 'application/json',
          'idempotency-key': projectId,
        },
        body: JSON.stringify(body),
      });
    expect(
      (await POST(request('https://other.test', command), context(target)))
        .status,
    ).toBe(403);
    expect(
      (
        await POST(
          request('http://wiser.test', { ...command, approvedBy: projectId }),
          context(target),
        )
      ).status,
    ).toBe(400);
    const method = action === 'revoke' ? client.revokeGrant : client.renewGrant;
    method.mockResolvedValue({ recorded: true });
    const response = await POST(
      request('http://wiser.test', command),
      context(target),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(method).toHaveBeenCalledWith(command, projectId);
  }
});

it('validates source stewardship reads and all commands without accepting caller authority', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const request = (body: unknown) =>
    new Request('http://wiser.test/api/platform/access/source-policy-decide', {
      method: 'POST',
      headers: {
        origin: 'http://wiser.test',
        host: 'wiser.test',
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify(body),
    });
  client.sourcePolicyRequests.mockResolvedValue({
    items: [],
    hasMore: false,
    canPropose: false,
    canApprove: true,
    checkedAt: new Date().toISOString(),
  });
  const page = await GET(
    new Request(
      `http://wiser.test/api/platform/access/source-policy-requests?projectId=${id}&status=pending`,
    ),
    context('source-policy-requests'),
  );
  expect(page.status).toBe(200);
  expect(client.sourcePolicyRequests).toHaveBeenCalledWith(id, {
    offset: 0,
    limit: 20,
    status: 'pending',
  });
  expect(page.headers.get('cache-control')).toBe('private, no-store');
  for (const query of [
    '&limit=21',
    '&canApprove=true',
    '&status=pending&status=published',
  ]) {
    expect(
      (
        await GET(
          new Request(
            `http://wiser.test/api/platform/access/source-policy-requests?projectId=${id}${query}`,
          ),
          context('source-policy-requests'),
        )
      ).status,
    ).toBe(400);
  }
  const common = {
    projectId: id,
    requestId: id,
    expectedVersion: 1,
    reason: 'Approved research scope',
  };
  const proposal = {
    projectId: id,
    policyId: id,
    expectedPolicyVersion: 0,
    resource: { kind: 'version', dataItemId: id, versionId: id },
    allowedActions: ['content.read'],
    managementRoles: ['data-manager'],
    licenseBasis: 'Public redistribution permission',
    startsAt: '2026-09-23T00:00:00Z',
    expiresAt: '2026-10-23T00:00:00Z',
    maxGrantDays: 7,
    reason: 'Approved research scope',
  };
  const commands = [
    {
      action: 'source-policy-propose',
      fn: client.proposeSourcePolicy,
      body: proposal,
    },
    {
      action: 'source-policy-decide',
      fn: client.decideSourcePolicy,
      body: { ...common, decision: 'publish' },
    },
    {
      action: 'source-policy-withdraw',
      fn: client.withdrawSourcePolicy,
      body: common,
    },
    {
      action: 'source-policy-revoke',
      fn: client.revokeSourcePolicy,
      body: {
        projectId: id,
        policyId: id,
        policyVersion: 1,
        reason: common.reason,
      },
    },
  ];
  for (const command of commands) {
    command.fn.mockResolvedValue({ accepted: true });
    expect(
      (await POST(request(command.body), context(command.action))).status,
    ).toBe(200);
    expect(command.fn).toHaveBeenCalledWith(command.body, id);
    expect(
      (
        await POST(
          request({ ...command.body, canApprove: true }),
          context(command.action),
        )
      ).status,
    ).toBe(400);
  }
});
