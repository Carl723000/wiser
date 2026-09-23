import { describe, expect, it } from 'vitest';
import { evaluateResourceAccess } from '../src/resource-access-policy.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-09-23T00:00:00Z';
const resource = { kind: 'version', dataItemId: id(4), versionId: id(5) };
const grant = {
  id: id(6),
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'research',
  packageId: id(7),
  packageVersion: 1,
  presetId: id(8),
  presetVersion: 1,
  resources: [resource],
  actions: ['content.read'],
  startsAt: '2026-09-22T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  status: 'active',
};
const input = {
  mode: 'managed',
  tenantId: id(1),
  projectId: id(2),
  actorId: id(3),
  purpose: 'research',
  resource,
  action: 'content.read',
  now,
  baseAllowed: true,
  resourceAvailable: true,
  providerAllowed: true,
  grants: [grant],
};

describe('resource access policy', () => {
  it('allows only an explicit matching grant and explains its fixed versions', () => {
    expect(evaluateResourceAccess(input)).toEqual({
      allowed: true,
      reason: 'GRANTED',
      grantIds: [id(6)],
      validUntil: grant.expiresAt,
    });
  });
  it('does not infer original or export permission from content reading', () => {
    for (const action of ['original.read', 'result.export', 'source.discover'])
      expect(evaluateResourceAccess({ ...input, action }).allowed).toBe(false);
  });
  it('preserves legacy rules only for explicitly legacy projects', () => {
    expect(
      evaluateResourceAccess({ ...input, mode: 'legacy', grants: [] }).allowed,
    ).toBe(true);
    expect(evaluateResourceAccess({ ...input, grants: [] }).allowed).toBe(
      false,
    );
    expect(evaluateResourceAccess({ ...input, mode: undefined }).allowed).toBe(
      false,
    );
  });
  it('never substitutes a matching name or newly published version', () => {
    for (const changed of [
      { ...resource, versionId: id(9) },
      { ...resource, dataItemId: id(9) },
    ])
      expect(
        evaluateResourceAccess({ ...input, resource: changed }).allowed,
      ).toBe(false);
  });
  it('binds tenant, project, subject and purpose', () => {
    for (const field of ['tenantId', 'projectId', 'actorId', 'purpose'])
      expect(
        evaluateResourceAccess({
          ...input,
          [field]: field === 'purpose' ? 'teaching' : id(9),
        }).allowed,
      ).toBe(false);
  });
  it('fails at exact expiry, before activation and after revocation', () => {
    for (const patch of [
      { expiresAt: now },
      { startsAt: '2026-09-24T00:00:00Z' },
      { status: 'revoked' },
    ])
      expect(
        evaluateResourceAccess({ ...input, grants: [{ ...grant, ...patch }] })
          .allowed,
      ).toBe(false);
  });
  it('retains independent overlapping grants after one is revoked', () => {
    expect(
      evaluateResourceAccess({
        ...input,
        grants: [
          { ...grant, status: 'revoked' },
          { ...grant, id: id(9) },
        ],
      }).grantIds,
    ).toEqual([id(9)]);
  });
  it('rejects a resource grant when project, resource or provider limits deny', () => {
    for (const mode of ['managed', 'legacy'])
      for (const field of [
        'baseAllowed',
        'resourceAvailable',
        'providerAllowed',
      ])
        expect(
          evaluateResourceAccess({ ...input, mode, [field]: false }).allowed,
        ).toBe(false);
  });
  it('separates a discoverable external source from its restricted directory call', () => {
    const source = {
      kind: 'external-source',
      sourceId: 'monitoring-directory',
    };
    const sourceInput = {
      ...input,
      resource: source,
      action: 'source.discover',
      grants: [{ ...grant, resources: [source], actions: ['source.discover'] }],
    };
    expect(evaluateResourceAccess(sourceInput).allowed).toBe(true);
    expect(
      evaluateResourceAccess({ ...sourceInput, action: 'external.directory' })
        .allowed,
    ).toBe(false);
  });
  it('fails closed for malformed authority input without leaking partial matches', () => {
    for (const patch of [
      { now: 'invalid' },
      { grants: [grant, { ...grant, expiresAt: 'invalid' }] },
      { baseAllowed: undefined },
      { resource: { kind: 'all' } },
    ])
      expect(evaluateResourceAccess({ ...input, ...patch })).toEqual({
        allowed: false,
        reason: 'INVALID_POLICY',
        grantIds: [],
        validUntil: null,
      });
  });
  it('rejects duplicate grant identifiers rather than hiding authority inconsistency', () => {
    expect(
      evaluateResourceAccess({
        ...input,
        grants: [grant, { ...grant, actions: ['original.read'] }],
      }).allowed,
    ).toBe(false);
  });
  it('returns deterministic grant order and earliest revalidation time', () => {
    const earlier = '2026-09-25T00:00:00Z';
    const grants = [
      { ...grant, id: id(9) },
      { ...grant, expiresAt: earlier },
    ];
    const result = evaluateResourceAccess({ ...input, grants });
    expect(result.grantIds).toEqual([id(6), id(9)]);
    expect(result.validUntil).toBe(earlier);
    expect(
      evaluateResourceAccess({ ...input, grants: [...grants].reverse() }),
    ).toEqual(result);
  });
});
