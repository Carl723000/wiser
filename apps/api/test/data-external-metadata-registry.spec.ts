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
  const ports = createTrustedExternalMetadataPorts(
    { resolve },
    { now: () => now },
  );
  return { record, resolve, readPage, ports };
}
describe('trusted external source registry', () => {
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
    const executor = createExternalMetadataExecutor(f.ports.resolveReader);
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
    const executor = createExternalMetadataExecutor(f.ports.resolveReader);
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
    const executor = createExternalMetadataExecutor(f.ports.resolveReader);
    await expect(executor.execute(request, context)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
