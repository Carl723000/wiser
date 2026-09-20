import { describe, expect, it, vi } from 'vitest';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import { ExternalMetadataReader } from '../src/data-foundation/external-metadata.js';

const sourceId = 'e1000000-0000-4000-8000-000000000001';
const actorId = 'e1000000-0000-4000-8000-000000000002';
const tenantId = 'e1000000-0000-4000-8000-000000000003';
const projectId = 'e1000000-0000-4000-8000-000000000004';
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
    purpose: 'water-governance',
    roles: ['reader'],
    scopes: ['data.catalog.read'],
    maxSecurityLevel: 'L2_RESTRICTED',
    authzVersion: 7,
  },
  effectiveMaxSecurityLevel: 'L2_RESTRICTED',
  traceId: 'e'.repeat(32),
  auditLevel: 'STANDARD',
  timeoutMs: 30000,
  signal: new AbortController().signal,
};
const now = Date.parse('2026-09-20T00:00:00Z');
const grant = {
  sourceId,
  actorId,
  actorType: 'human',
  tenantId,
  projectId,
  purpose: 'water-governance',
  authzVersion: 7,
  policyVersion: 'v1',
  expiresAt: '2026-09-21T00:00:00Z',
  fromYear: 2021,
  toYear: 2025,
  fields: ['stationCode', 'year', 'province'],
  securityLevel: 'L2_RESTRICTED',
};
const row = {
  stationCode: 'SYNTHETIC-A',
  year: 2024,
  province: 'Synthetic province',
  city: 'Hidden city',
  value: 123.456,
  token: 'synthetic-not-a-secret',
};
function setup() {
  const resolve = vi.fn((): Promise<unknown> =>
    Promise.resolve(structuredClone(grant)),
  );
  const readPage = vi.fn((): Promise<unknown> =>
    Promise.resolve({ items: [row], total: 1 }),
  );
  const reader = new ExternalMetadataReader({
    access: { resolve },
    provider: { readPage },
    now: () => now,
  });
  return { resolve, readPage, reader };
}

describe('external metadata authority and projection', () => {
  it('returns only granted metadata, at year precision, without mutating the provider row', async () => {
    const { reader } = setup();
    expect(await reader.read(request, context)).toEqual({
      sourceId,
      status: 'AVAILABLE',
      items: [
        {
          stationCode: 'SYNTHETIC-A',
          year: 2024,
          province: 'Synthetic province',
        },
      ],
      total: 1,
      checkedAt: '2026-09-20T00:00:00.000Z',
      timePrecision: 'year',
    });
    expect(row.value).toBe(123.456);
  });
  it.each(['url', 'token', 'fields', 'grant'])(
    'rejects caller-supplied %s before contacting a provider',
    async (key) => {
      const s = setup();
      await expect(
        s.reader.read({ ...request, [key]: 'not-allowed' }, context),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(s.readPage).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['actorId', sourceId],
    ['actorType', 'agent'],
    ['tenantId', sourceId],
    ['projectId', sourceId],
    ['purpose', 'another-purpose'],
    ['sourceId', actorId],
    ['authzVersion', 8],
    ['securityLevel', 'L3_CONFIDENTIAL'],
    ['fields', ['stationCode', 'year', 'value']],
    ['fromYear', 2022],
    ['toYear', 2024],
  ])(
    'rejects mismatched or insufficient %s authority',
    async (field, value) => {
      const s = setup();
      s.resolve.mockResolvedValue({ ...grant, [field]: value });
      await expect(s.reader.read(request, context)).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      });
      expect(s.readPage).not.toHaveBeenCalled();
    },
  );
  it('fails closed when no source-specific grant is configured', async () => {
    const s = setup();
    s.resolve.mockResolvedValue(null);
    await expect(s.reader.read(request, context)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(s.readPage).not.toHaveBeenCalled();
  });
  it('distinguishes expired access from an empty result', async () => {
    const s = setup();
    s.resolve.mockResolvedValue({
      ...grant,
      expiresAt: '2026-09-20T00:00:00Z',
    });
    await expect(s.reader.read(request, context)).rejects.toMatchObject({
      code: 'AUTHORIZATION_EXPIRED',
    });
    expect(s.readPage).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...grant, policyVersion: 'v2' },
    { ...grant, fields: ['stationCode', 'year'] },
    { ...grant, authzVersion: 8 },
  ])(
    'discards a response after authority changes in flight: %j',
    async (next) => {
      const s = setup();
      s.resolve.mockResolvedValueOnce(grant).mockResolvedValueOnce(next);
      await expect(s.reader.read(request, context)).rejects.toMatchObject({
        code: 'ACCESS_DENIED',
      });
    },
  );
  it('rechecks expiry after the response', async () => {
    const s = setup();
    let time = now;
    s.readPage.mockImplementation(() => {
      time += 86400000;
      return Promise.resolve({ items: [row], total: 1 });
    });
    const reader = new ExternalMetadataReader({
      access: { resolve: s.resolve },
      provider: { readPage: s.readPage },
      now: () => time,
    });
    await expect(reader.read(request, context)).rejects.toMatchObject({
      code: 'AUTHORIZATION_EXPIRED',
    });
  });
  it('each page needs a fresh grant; a previous success gives no continuing access', async () => {
    const s = setup();
    s.readPage.mockResolvedValue({ items: [row], total: 3 });
    const first = await s.reader.read(request, context);
    expect(first.nextOffset).toBe(1);
    s.resolve.mockResolvedValue(null);
    await expect(
      s.reader.read({ ...request, offset: first.nextOffset }, context),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(s.readPage).toHaveBeenCalledTimes(1);
  });
  it('does not treat errors as a zero-row result or expose provider errors', async () => {
    const s = setup();
    s.readPage.mockRejectedValue(new Error('upstream-token-and-values'));
    await expect(s.reader.read(request, context)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'SOURCE_UNAVAILABLE',
    });
  });
  it('only a valid zero-row response is EMPTY', async () => {
    const s = setup();
    s.readPage.mockResolvedValue({ items: [], total: 0 });
    expect(await s.reader.read(request, context)).toMatchObject({
      status: 'EMPTY',
      items: [],
      total: 0,
    });
  });
  it.each([
    { items: [], total: 1 },
    { items: [row], total: 0 },
    { items: [row, row, row], total: 3 },
    { items: [{ ...row, year: 2020 }], total: 1 },
    { items: [{ year: 2024 }], total: 1 },
    { items: [{ ...row, stationCode: ' ' }], total: 1 },
    { items: [row, row], total: 2 },
  ])(
    'rejects incomplete, duplicated, out-of-range or inconsistent provider pages: %j',
    async (page) => {
      const s = setup();
      s.readPage.mockResolvedValue(page);
      await expect(s.reader.read(request, context)).rejects.toMatchObject({
        code: 'INVALID_METADATA',
      });
    },
  );
  it('stops before fetch if cancelled', async () => {
    const s = setup();
    await expect(
      s.reader.read(request, { ...context, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(s.readPage).not.toHaveBeenCalled();
  });
  it('discards a late result if cancelled while fetching', async () => {
    const s = setup();
    const controller = new AbortController();
    s.readPage.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ items: [row], total: 1 });
    });
    await expect(
      s.reader.read(request, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('does not block cancellation on a provider that ignores the signal', async () => {
    const s = setup();
    const controller = new AbortController();
    s.readPage.mockImplementation(() => {
      controller.abort();
      return new Promise(() => {});
    });
    await expect(
      s.reader.read(request, { ...context, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
