import { describe, expect, it } from 'vitest';
import {
  checkProjectGrant,
  checkProjectRemoval,
  type ProjectGrantCheck,
} from '../src/project-access-policy.js';

const now = Date.parse('2026-09-22T00:00:00Z');
const command: ProjectGrantCheck = {
  actorId: 'manager',
  targetActorId: 'reader',
  action: 'manage',
  scopes: ['platform.membership.manage'],
  role: {
    key: 'data-reader',
    active: true,
    scopes: ['data.catalog.read'],
    securityLevel: 'L1_INTERNAL',
  },
  policy: { roleKey: 'data-reader', maxDays: 30 },
  managerSecurityLevel: 'L1_INTERNAL',
  managerExpiresAt: '2026-10-15T00:00:00Z',
  expiresAt: '2026-10-01T00:00:00Z',
  now,
};

describe('project grant policy', () => {
  it('permits an explicitly assignable bounded data role', () => {
    expect(checkProjectGrant(command)).toBeNull();
  });
  it('does not infer delegation rights from data access or a project-manage scope', () => {
    for (const scopes of [
      ['data.catalog.read'],
      ['platform.project.manage'],
      [],
    ]) {
      expect(checkProjectGrant({ ...command, scopes })).toBe('NOT_AUTHORIZED');
    }
  });
  it('requires separate approval authority and prevents self-approval/elevation', () => {
    expect(checkProjectGrant({ ...command, action: 'approve' })).toBe(
      'NOT_AUTHORIZED',
    );
    expect(
      checkProjectGrant({
        ...command,
        action: 'approve',
        scopes: ['platform.access.approve'],
      }),
    ).toBeNull();
    expect(checkProjectGrant({ ...command, targetActorId: 'manager' })).toBe(
      'SELF_CHANGE_FORBIDDEN',
    );
  });
  it('fails closed for an unconfigured, retired or management role', () => {
    expect(checkProjectGrant({ ...command, policy: null })).toBe(
      'ROLE_NOT_ASSIGNABLE',
    );
    expect(
      checkProjectGrant({
        ...command,
        policy: { roleKey: 'another-role', maxDays: 30 },
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
    expect(
      checkProjectGrant({
        ...command,
        role: { ...command.role, active: false },
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
    expect(
      checkProjectGrant({
        ...command,
        role: { ...command.role, scopes: ['platform.membership.manage'] },
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
  });
  it('cannot give a higher confidentiality ceiling', () => {
    expect(
      checkProjectGrant({
        ...command,
        role: { ...command.role, securityLevel: 'L2_RESTRICTED' },
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
  });
  it('rejects expired, invalid, unbounded and overlong grant periods', () => {
    for (const expiresAt of [
      '2026-09-22T00:00:00Z',
      'invalid',
      '2027-01-01T00:00:00Z',
    ]) {
      expect(checkProjectGrant({ ...command, expiresAt })).toBe(
        'INVALID_EXPIRY',
      );
    }
    expect(
      checkProjectGrant({
        ...command,
        managerExpiresAt: '2026-09-25T00:00:00Z',
      }),
    ).toBe('INVALID_EXPIRY');
    expect(checkProjectGrant({ ...command, now: NaN })).toBe('INVALID_EXPIRY');
    expect(
      checkProjectGrant({
        ...command,
        policy: { roleKey: 'data-reader', maxDays: 0 },
      }),
    ).toBe('ROLE_NOT_ASSIGNABLE');
    expect(
      checkProjectGrant({
        ...command,
        policy: { roleKey: 'data-reader', maxDays: 1 },
      }),
    ).toBe('INVALID_EXPIRY');
  });
  it('allows an unbounded administrator to issue only a bounded grant', () => {
    expect(
      checkProjectGrant({ ...command, managerExpiresAt: null }),
    ).toBeNull();
  });
});

describe('project member removal', () => {
  const removal = {
    actorId: 'manager',
    targetActorId: 'reader',
    scopes: ['platform.membership.manage'],
    targetHasManagementAuthority: false,
  };
  it('allows ordinary project-member removal with explicit authority', () => {
    expect(checkProjectRemoval(removal)).toBeNull();
  });
  it('forbids unauthorised removal, self-removal and protected administrator removal', () => {
    expect(checkProjectRemoval({ ...removal, scopes: [] })).toBe(
      'NOT_AUTHORIZED',
    );
    expect(checkProjectRemoval({ ...removal, targetActorId: 'manager' })).toBe(
      'SELF_CHANGE_FORBIDDEN',
    );
    expect(
      checkProjectRemoval({ ...removal, targetHasManagementAuthority: true }),
    ).toBe('PROTECTED_MEMBER');
  });
});
