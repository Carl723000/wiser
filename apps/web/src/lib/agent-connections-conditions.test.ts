import { expect, it } from 'vitest';
import { readAgentConnectionConditions } from './agent-connections';

const now = Date.parse('2026-10-05T12:00:00Z');
const connection = { status: 'active', expiresAt: null } as const;
const membership = {
  state: 'loaded',
  memberStatus: 'active',
  expiresAt: null,
  roles: ['data-reader'],
} as const;

it('describes active membership as a necessary condition, never a resource-access verdict', () => {
  expect(readAgentConnectionConditions(connection, membership, now)).toEqual({
    connectionStatus: 'active',
    memberState: 'active',
    currentState: 'conditions-met',
  });
});
it.each(['not-loaded', 'not-visible', 'unavailable'] as const)(
  'keeps %s project conditions unknown',
  (state) => {
    expect(readAgentConnectionConditions(connection, { state }, now)).toEqual({
      connectionStatus: 'active',
      memberState: 'unknown',
      currentState: 'unknown',
    });
  },
);
it.each([
  ['2026-10-05T11:59:59Z', 'expired'],
  ['2026-10-05T12:00:00Z', 'expired'],
  ['2026-10-05T12:00:01Z', 'active'],
] as const)(
  'uses the exact membership expiry boundary %s',
  (expiresAt, memberState) => {
    expect(
      readAgentConnectionConditions(
        connection,
        { ...membership, expiresAt },
        now,
      ),
    ).toMatchObject({
      memberState,
      currentState:
        memberState === 'active' ? 'conditions-met' : 'member-expired',
    });
  },
);
it.each([
  ['revoked', 'revoked', 'member-revoked'],
  ['suspended', 'suspended', 'member-suspended'],
  ['expired', 'expired', 'member-expired'],
  [null, 'none', 'no-member'],
  ['future', 'unknown', 'unknown'],
] as const)(
  'retains the actual member state %s',
  (memberStatus, memberState, currentState) => {
    expect(
      readAgentConnectionConditions(
        connection,
        { ...membership, memberStatus },
        now,
      ),
    ).toMatchObject({ memberState, currentState });
  },
);
it('does not treat an active membership with no effective roles as usable', () => {
  expect(
    readAgentConnectionConditions(
      connection,
      { ...membership, roles: [] },
      now,
    ),
  ).toMatchObject({ memberState: 'active', currentState: 'no-role' });
});
it('reports a stopped or expired connection even when project lookup fails', () => {
  expect(
    readAgentConnectionConditions(
      { status: 'revoked', expiresAt: null },
      { state: 'unavailable' },
      now,
    ),
  ).toMatchObject({
    connectionStatus: 'revoked',
    currentState: 'connection-revoked',
  });
  expect(
    readAgentConnectionConditions(
      { status: 'active', expiresAt: '2026-10-05T12:00:00Z' },
      { state: 'unavailable' },
      now,
    ),
  ).toMatchObject({
    connectionStatus: 'expired',
    currentState: 'connection-expired',
  });
  expect(
    readAgentConnectionConditions(
      { status: 'expired', expiresAt: null },
      membership,
      now,
    ),
  ).toMatchObject({
    connectionStatus: 'expired',
    currentState: 'connection-expired',
  });
});
