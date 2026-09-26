import { describe, expect, it } from 'vitest';
import {
  ProjectAccessGrantSchema,
  ProjectAccessInviteSchema,
  ProjectAccessPageSchema,
  ProjectAccessRevokeSchema,
} from '../src/project-access.js';
const id = '12345678-1234-4234-8234-123456789012';
const grant = {
  projectId: id,
  actorId: id,
  roleKey: 'data-reader',
  expiresAt: '2026-10-01T00:00:00Z',
  reason: 'Read a public demonstration.',
  expectedVersion: 0,
};
describe('project access contracts', () => {
  it('bounds grants and rejects caller-controlled authorization fields', () => {
    expect(ProjectAccessGrantSchema.safeParse(grant).success).toBe(true);
    for (const patch of [
      { admin: true },
      { tenantId: id },
      { expectedVersion: -1 },
      { expiresAt: 'tomorrow' },
      { reason: '' },
    ])
      expect(
        ProjectAccessGrantSchema.safeParse({ ...grant, ...patch }).success,
      ).toBe(false);
  });
  it('requires a current version for member revocation', () => {
    const revoke = {
      projectId: id,
      actorId: id,
      reason: 'Project review finished.',
      expectedVersion: 1,
    };
    expect(ProjectAccessRevokeSchema.safeParse(revoke).success).toBe(true);
    expect(
      ProjectAccessRevokeSchema.safeParse({ ...revoke, expectedVersion: 0 })
        .success,
    ).toBe(false);
  });
  it('does not accept credentials or provider parameters with an invitation', () => {
    const invite = {
      projectId: id,
      email: 'reader@example.test',
      roleKey: 'data-reader',
      expiresAt: grant.expiresAt,
      reason: grant.reason,
    };
    expect(ProjectAccessInviteSchema.safeParse(invite).success).toBe(true);
    for (const patch of [
      { password: 'not-accepted' },
      { redirectTo: 'https://outside.invalid' },
      { email: 'invalid' },
    ])
      expect(
        ProjectAccessInviteSchema.safeParse({ ...invite, ...patch }).success,
      ).toBe(false);
  });
  it('bounds pagination and search, rejecting arbitrary query filters', () => {
    expect(ProjectAccessPageSchema.parse({})).toEqual({
      offset: 0,
      limit: 20,
      search: '',
    });
    for (const input of [
      { limit: 51 },
      { offset: -1 },
      { search: 'x'.repeat(101) },
      { tenantId: id },
    ])
      expect(ProjectAccessPageSchema.safeParse(input).success).toBe(false);
  });
});
