import { describe, expect, it, vi } from 'vitest';
import { createTrustedExternalMetadataPorts } from '../src/data-foundation/external-metadata-registry.js';
import { createExternalMetadataExecutor } from '../src/data-foundation/external-metadata-executor.js';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';

const sourceId = 'e3000000-0000-4000-8000-000000000001';
const actorId = 'e3000000-0000-4000-8000-000000000002';
const tenantId = 'e3000000-0000-4000-8000-000000000003';
const projectId = 'e3000000-0000-4000-8000-000000000004';
const request = { sourceId, fromYear: 2021, toYear: 2025, offset: 0, limit: 2 };
const context: DataCapabilityExecutionContext = {
  principal: {
    actorType: 'human',
    actorId,
    authUserId: actorId,
    sessionId: sourceId,
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId,
    projectId,
    purpose: 'metadata-read',
    roles: ['reader'],
    scopes: ['data.catalog.read'],
    maxSecurityLevel: 'L2_RESTRICTED',
    authzVersion: 7,
    resourceAccess: {
      revision: 1,
      fingerprint: 'a'.repeat(64),
      scope: {
        mode: 'managed',
        validUntil: '2099-01-01T00:00:00Z',
        permissions: {
          'source.discover': [{ kind: 'external-source', sourceId }],
          'external.directory': [{ kind: 'external-source', sourceId }],
          'content.read': [],
          'original.read': [],
          'result.export': [],
        },
      },
    },
  },
  effectiveMaxSecurityLevel: 'L2_RESTRICTED',
  traceId: 'e'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30000,
  signal: new AbortController().signal,
};
const now = Date.parse('2026-09-23T00:00:00Z');
function fixture() {
  const readPage = vi.fn(() =>
    Promise.resolve({
      items: [{ stationCode: 'SYNTHETIC-A', year: 2024, value: 999 }],
      total: 1,
    }),
  );
  const record = {
    sourceId,
    tenantId,
    projectId,
    bindingVersion: 'adapter-v1',
    managementVisible: true,
    managementLicenseBasis:
      'Synthetic provider approval for directory metadata',
    providerPermission: {
      status: 'VERIFIED' as const,
      policyVersion: 'permit-v1',
      basis: 'Synthetic provider approval for directory metadata',
      startsAt: '2026-01-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
      fromYear: 2020,
      toYear: 2025,
      fields: ['stationCode', 'year'] as const,
      actions: ['source.discover', 'external.directory'] as const,
      securityLevel: 'L2_RESTRICTED' as const,
    },
    provider: { readPage },
  };
  const resolve = vi.fn((): Promise<unknown> => Promise.resolve(record));
  const listed = {
    sourceId,
    tenantId,
    projectId,
    name: 'Synthetic station directory',
    providerName: 'Synthetic supplier',
    securityLevel: 'L2_RESTRICTED',
    managementVisible: true,
    providerPermissionStatus: 'VERIFIED',
    expiresAt: '2027-01-01T00:00:00Z',
  };
  const list = vi.fn((): Promise<unknown> =>
    Promise.resolve({
      items: [listed],
      hasMore: false,
    }),
  );
  const ports = createTrustedExternalMetadataPorts(
    { resolve, list },
    { now: () => now },
  );
  return { record, listed, resolve, list, readPage, ports };
}
describe('trusted external source registry', () => {
  it('keeps proposals disabled when a host has no management listing', async () => {
    const f = fixture();
    const ports = createTrustedExternalMetadataPorts(
      { resolve: f.resolve },
      { now: () => now },
    );
    expect(
      await ports.listManagementSources({
        context,
        page: { offset: 0, limit: 20 },
        signal: context.signal,
      }),
    ).toEqual({ items: [], hasMore: false });
    expect(
      await ports.validateExternalSource({
        context,
        sourceId,
        actions: ['source.discover'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(false);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it('lists only current, safe source descriptions and never exposes an adapter', async () => {
    const f = fixture();
    const result = await f.ports.listManagementSources({
      context,
      page: { offset: 0, limit: 20 },
      signal: context.signal,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        sourceId,
        name: 'Synthetic station directory',
        provider: 'Synthetic supplier',
        providerPermissionStatus: 'VERIFIED',
        allowedFields: ['stationCode', 'year'],
        allowedActions: ['source.discover', 'external.directory'],
        fromYear: 2020,
        toYear: 2025,
        eligibleForProposal: true,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('readPage');
    const steward: DataCapabilityExecutionContext = {
      ...context,
      authorization: {
        ...context.authorization,
        maxSecurityLevel: 'L0_PUBLIC',
      },
    };
    const managed = await f.ports.listManagementSources({
      context: steward,
      page: { offset: 0, limit: 20 },
      signal: steward.signal,
    });
    expect(managed.items[0]?.eligibleForProposal).toBe(true);
    f.list.mockResolvedValueOnce({
      items: [{ ...f.listed, tenantId: actorId }],
      hasMore: false,
    });
    await expect(
      f.ports.listManagementSources({
        context,
        page: { offset: 0, limit: 20 },
        signal: context.signal,
      }),
    ).rejects.toThrow();
  });
  it('does not enable proposals for missing, expired or revoked supplier permission', async () => {
    const f = fixture();
    const listed = f.listed;
    for (const status of ['PENDING', 'EXPIRED', 'REVOKED'] as const) {
      f.list.mockResolvedValueOnce({
        items: [{ ...listed, providerPermissionStatus: status }],
        hasMore: false,
      });
      const page = await f.ports.listManagementSources({
        context,
        page: { offset: 0, limit: 20 },
        signal: context.signal,
      });
      expect(page.items[0]).toMatchObject({
        providerPermissionStatus: status,
        eligibleForProposal: false,
        allowedActions: [],
      });
    }
    f.resolve.mockResolvedValueOnce(null);
    const missing = await f.ports.listManagementSources({
      context,
      page: { offset: 0, limit: 20 },
      signal: context.signal,
    });
    expect(missing.items[0]?.eligibleForProposal).toBe(false);
  });
  it('matches a fixed source and current provider permission for package validation', async () => {
    const f = fixture();
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId,
        actions: ['external.directory'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(true);
    f.resolve.mockResolvedValueOnce({ ...f.record, managementVisible: false });
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId,
        actions: ['external.directory'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(false);
    f.resolve.mockResolvedValueOnce({
      ...f.record,
      managementLicenseBasis: undefined,
    });
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId,
        actions: ['external.directory'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(false);
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId: actorId,
        actions: ['external.directory'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(false);
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId,
        actions: ['content.read'],
        licenseBasis: f.record.providerPermission.basis,
        signal: context.signal,
      }),
    ).toBe(false);
    expect(
      await f.ports.validateExternalSource({
        context,
        sourceId,
        actions: ['external.directory'],
        licenseBasis: 'Unrelated self-declared license',
        signal: context.signal,
      }),
    ).toBe(false);
  });
  it('keeps WISER source policy terms inside the verified supplier window', async () => {
    const f = fixture();
    const base = {
      context,
      sourceId,
      actions: ['external.directory'] as const,
      licenseBasis: f.record.providerPermission.basis,
      signal: context.signal,
    };
    expect(
      await f.ports.validateExternalSource({
        ...base,
        policyWindow: {
          startsAt: '2026-01-01T00:00:00Z',
          expiresAt: '2027-01-01T00:00:00Z',
        },
      }),
    ).toBe(true);
    for (const policyWindow of [
      { startsAt: '2025-12-31T23:59:59Z', expiresAt: '2026-12-01T00:00:00Z' },
      { startsAt: '2026-09-23T00:00:00Z', expiresAt: '2027-01-02T00:00:00Z' },
      { startsAt: '2026-10-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' },
    ])
      expect(
        await f.ports.validateExternalSource({ ...base, policyWindow }),
      ).toBe(false);
  });
  it('serves only listed metadata after independent WISER action and supplier checks', async () => {
    const f = fixture();
    const executor = createExternalMetadataExecutor((id, ctx) =>
      f.ports.resolveReader(id, ctx),
    );
    expect(await executor.execute(request, context)).toMatchObject({
      items: [{ stationCode: 'SYNTHETIC-A', year: 2024 }],
    });
    expect(
      JSON.stringify(await executor.execute(request, context)),
    ).not.toContain('999');
    const denied = structuredClone(context);
    if (denied.authorization.resourceAccess?.scope.mode !== 'managed')
      throw new Error('Invalid fixture');
    denied.authorization.resourceAccess.scope.permissions[
      'external.directory'
    ] = [];
    await expect(executor.execute(request, denied)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.readPage).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-project, expired, unverified and malformed provider registrations', async () => {
    const f = fixture();
    const params = {
      context,
      sourceId,
      actions: ['external.directory'] as const,
      licenseBasis: f.record.providerPermission.basis,
      signal: context.signal,
    };
    for (const registration of [
      { ...f.record, projectId: actorId },
      {
        ...f.record,
        providerPermission: {
          ...f.record.providerPermission,
          status: 'PENDING',
        },
      },
      {
        ...f.record,
        providerPermission: {
          ...f.record.providerPermission,
          expiresAt: '2026-01-01T00:00:00Z',
        },
      },
      {
        ...f.record,
        providerPermission: {
          ...f.record.providerPermission,
          fields: ['stationCode', 'year', 'value'],
        },
      },
    ]) {
      f.resolve.mockResolvedValueOnce(registration);
      expect(await f.ports.validateExternalSource(params)).toBe(false);
    }
  });
  it('discards an in-flight page if the provider permission or binding changes', async () => {
    const f = fixture();
    const changed = { ...f.record, bindingVersion: 'adapter-v2' };
    f.readPage.mockImplementation(() => {
      f.resolve.mockResolvedValue(changed);
      return Promise.resolve({
        items: [{ stationCode: 'SYNTHETIC-A', year: 2024, value: 999 }],
        total: 1,
      });
    });
    const executor = createExternalMetadataExecutor((id, ctx) =>
      f.ports.resolveReader(id, ctx),
    );
    await expect(executor.execute(request, context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('discards an in-flight page after source permission is revoked', async () => {
    const f = fixture();
    f.readPage.mockImplementation(() => {
      f.resolve.mockResolvedValue({
        ...f.record,
        providerPermission: {
          ...f.record.providerPermission,
          status: 'REVOKED',
        },
      });
      return Promise.resolve({
        items: [{ stationCode: 'SYNTHETIC-A', year: 2024, value: 999 }],
        total: 1,
      });
    });
    const executor = createExternalMetadataExecutor((id, ctx) =>
      f.ports.resolveReader(id, ctx),
    );
    await expect(executor.execute(request, context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
