import { authorizeManagementMetadata } from './resource-management-fixture.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceAdministrationOptions } from '@wiser/platform-auth';
import { createDataResourcePackageValidator } from '../src/data-foundation/resource-package-validator.js';
type Input = Parameters<ResourceAdministrationOptions['validatePackage']>[0];
function input(): Input {
  const projectId = randomUUID(),
    actorId = randomUUID();
  return {
    signal: new AbortController().signal,
    context: {
      principal: {
        actorType: 'human',
        actorId,
        authUserId: actorId,
        sessionId: randomUUID(),
        authenticationMethod: 'supabase_jwt',
      },
      traceId: 'a'.repeat(32),
      authorization: {
        tenantId: randomUUID(),
        projectId,
        purpose: 'web-console',
        maxSecurityLevel: 'L1_INTERNAL',
        roles: ['manager'],
        scopes: ['data.catalog.read'],
        authzVersion: 1,
      },
    },
    command: {
      projectId,
      packageId: randomUUID(),
      expectedVersion: 0,
      name: 'Approved resources',
      resources: [
        { kind: 'version', dataItemId: randomUUID(), versionId: randomUUID() },
      ],
      allowedActions: ['content.read'],
      licenseBasis: 'Explicit declared source basis',
      reason: 'Prepare independent approval',
    },
  };
}
function fixture() {
  const query = vi.fn<
    (
      sql: string,
      values?: readonly unknown[],
    ) => Promise<{ rows: Record<string, unknown>[] }>
  >(() => Promise.resolve({ rows: [{ denied: 0 }] }));
  const release = vi.fn();
  const connect = vi.fn(() => Promise.resolve({ query, release }));
  return {
    query,
    release,
    connect,
    validate: createDataResourcePackageValidator({ connect }),
  };
}
function externalRequest(): Input {
  const request = input();
  request.command.resources = [
    { kind: 'external-source', sourceId: randomUUID() },
  ];
  request.command.allowedActions = ['source.discover', 'external.directory'];
  return request;
}
describe('Data package validation lifecycle', () => {
  it('fails closed for external policy proposals when no trusted registry is wired', async () => {
    const f = fixture();
    expect(
      await f.validate(await authorizeManagementMetadata(externalRequest())),
    ).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('validates a registered external source and verified provider licence through a separate trusted port', async () => {
    const f = fixture();
    const request = await authorizeManagementMetadata(externalRequest());
    request.policyWindow = {
      startsAt: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
    };
    const validateExternalSource = vi.fn(() => Promise.resolve(true));
    const validate = createDataResourcePackageValidator(
      { connect: f.connect },
      { validateExternalSource },
    );
    expect(await validate(request)).toBe(true);
    expect(validateExternalSource).toHaveBeenCalledOnce();
    const source = request.command.resources[0]!;
    if (source.kind !== 'external-source') throw new Error('Invalid fixture');
    expect(validateExternalSource).toHaveBeenCalledWith({
      context: request.context,
      sourceId: source.sourceId,
      actions: request.command.allowedActions,
      licenseBasis: request.command.licenseBasis,
      policyWindow: request.policyWindow,
      signal: request.signal,
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('rejects unknown, unlicensed, malformed or cross-action external sources without Data reads', async () => {
    const f = fixture();
    const validateExternalSource = vi.fn(() => Promise.resolve(false));
    const validate = createDataResourcePackageValidator(
      { connect: f.connect },
      { validateExternalSource },
    );
    expect(
      await validate(await authorizeManagementMetadata(externalRequest())),
    ).toBe(false);
    const accepted = await authorizeManagementMetadata(externalRequest());
    validateExternalSource.mockResolvedValue(true);
    accepted.command.resources = [
      { kind: 'external-source', sourceId: 'unregistered-slug' },
    ];
    expect(await validate(accepted)).toBe(false);
    const mixed = await authorizeManagementMetadata(externalRequest());
    mixed.command.resources.push({
      kind: 'version',
      dataItemId: randomUUID(),
      versionId: randomUUID(),
    });
    expect(await validate(mixed)).toBe(false);
    const crossAction = await authorizeManagementMetadata(externalRequest());
    crossAction.command.allowedActions = ['content.read'];
    expect(await validate(crossAction)).toBe(false);
    expect(validateExternalSource).toHaveBeenCalledTimes(1);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('discards external validation after revocation, cancellation or permit expiry', async () => {
    const f = fixture();
    const controller = new AbortController();
    const validateExternalSource = vi.fn(() => {
      controller.abort();
      return Promise.resolve(true);
    });
    const validate = createDataResourcePackageValidator(
      { connect: f.connect },
      { validateExternalSource },
    );
    const request = await authorizeManagementMetadata({
      ...externalRequest(),
      signal: controller.signal,
    });
    expect(await validate(request)).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('requires every source in a package to pass its current provider-permission check', async () => {
    const f = fixture();
    const request = externalRequest();
    request.command.resources.push({
      kind: 'external-source',
      sourceId: randomUUID(),
    });
    const validateExternalSource = vi
      .fn(() => Promise.resolve(true))
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const validate = createDataResourcePackageValidator(
      { connect: f.connect },
      { validateExternalSource },
    );
    expect(await validate(await authorizeManagementMetadata(request))).toBe(
      false,
    );
    expect(validateExternalSource).toHaveBeenCalledTimes(2);
    validateExternalSource.mockRejectedValue(
      new Error('private provider grant'),
    );
    expect(
      await validate(await authorizeManagementMetadata(externalRequest())),
    ).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not query the database for invalid, cancelled, external or wrong-project input', async () => {
    const f = fixture(),
      request = input();
    const cases: Input[] = [
      { ...request, signal: AbortSignal.abort() },
      { ...request, command: { ...request.command, projectId: randomUUID() } },
      { ...request, command: { ...request.command, resources: [] } },
      {
        ...request,
        command: {
          ...request.command,
          resources: [{ kind: 'external-source', sourceId: randomUUID() }],
        },
      },
      {
        ...request,
        command: { ...request.command, allowedActions: ['external.directory'] },
      },
      {
        ...request,
        context: {
          ...request.context,
          authorization: { ...request.context.authorization, scopes: [] },
        },
      },
    ];
    for (const value of cases) expect(await f.validate(value)).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('does not substitute a personal reading grant for a source-management authorization', async () => {
    const f = fixture(),
      request = input();
    request.context.authorization.scopes.push('platform.membership.manage');
    expect(await f.validate(request)).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('validates all immutable pairs with one authority query without exposing member rows', async () => {
    const f = fixture(),
      request = input();
    request.command.resources.push({
      kind: 'version',
      dataItemId: randomUUID(),
      versionId: randomUUID(),
    });
    expect(await f.validate(await authorizeManagementMetadata(request))).toBe(
      true,
    );
    const reads = f.query.mock.calls.filter(([sql]) =>
      sql.includes('data.resource-package.validation'),
    );
    expect(reads).toHaveLength(1);
    expect(JSON.parse(String(reads[0]![1]![0]))).toEqual(
      request.command.resources,
    );
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('rejects forged, reused, altered or expired management permits before opening a connection', async () => {
    const f = fixture(),
      request = await authorizeManagementMetadata(input());
    expect(
      await f.validate({
        ...request,
        managementPermit: { ...request.managementPermit! },
      }),
    ).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
    expect(await f.validate(request)).toBe(true);
    expect(await f.validate(request)).toBe(false);
    expect(f.connect).toHaveBeenCalledTimes(1);
    for (const field of [
      'actor',
      'project',
      'ceiling',
      'resource',
      'action',
    ] as const) {
      const r = await authorizeManagementMetadata(input());
      if (field === 'actor') r.context.principal.actorId = randomUUID();
      if (field === 'project')
        r.context.authorization.projectId = r.command.projectId = randomUUID();
      if (field === 'ceiling')
        r.context.authorization.maxSecurityLevel = 'L3_CONFIDENTIAL';
      if (field === 'resource')
        r.command.resources = [
          {
            kind: 'version',
            dataItemId: randomUUID(),
            versionId: randomUUID(),
          },
        ];
      if (field === 'action') r.command.allowedActions = ['original.read'];
      expect(await f.validate(r)).toBe(false);
    }
    const expired = await authorizeManagementMetadata(input()),
      now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    try {
      expect(await f.validate(expired)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it.each(['data.resource-package.validation', 'commit'])(
    'rejects a result whose management permit expires during %s',
    async (stage) => {
      const f = fixture(),
        request = await authorizeManagementMetadata(input()),
        now = Date.now();
      const clock = vi.spyOn(Date, 'now');
      f.query.mockImplementation((sql) => {
        if (sql.includes(stage)) clock.mockReturnValue(now + 6000);
        return Promise.resolve({ rows: [{ denied: 0 }] });
      });
      try {
        expect(await f.validate(request)).toBe(false);
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('rejects partial authority matches, rolls back query failures and always releases the connection', async () => {
    const f = fixture();
    f.query.mockImplementation((sql) =>
      sql.includes('data.resource-package.validation')
        ? Promise.resolve({ rows: [{ denied: 1 }] })
        : Promise.resolve({ rows: [] }),
    );
    expect(await f.validate(await authorizeManagementMetadata(input()))).toBe(
      false,
    );
    f.query.mockImplementation((sql) =>
      sql.includes('data.resource-package.validation')
        ? Promise.reject(new Error('private storage failure'))
        : Promise.resolve({ rows: [] }),
    );
    expect(await f.validate(await authorizeManagementMetadata(input()))).toBe(
      false,
    );
    expect(f.query).toHaveBeenCalledWith('rollback');
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it('does not confirm a package when cancellation arrives during the authority query', async () => {
    const f = fixture(),
      controller = new AbortController();
    f.query.mockImplementation((sql) => {
      if (sql.includes('data.resource-package.validation')) controller.abort();
      return Promise.resolve({ rows: [{ denied: 0 }] });
    });
    expect(
      await f.validate(
        await authorizeManagementMetadata({
          ...input(),
          signal: controller.signal,
        }),
      ),
    ).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });
});
