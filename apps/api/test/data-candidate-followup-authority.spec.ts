import { describe, expect, it } from 'vitest';
import { createCandidateFollowupAssigneeAuthority } from '../src/platform/candidate-followup-assignee-authority.js';
import { DATA_CAPABILITY_REGISTRY } from '@wiser/data-contracts';
const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceContext = {
  tenantId: id(1),
  projectId: id(2),
  purpose: 'candidate-review',
};
const eligible = {
  actor_id: id(3),
  actor_type: 'human',
  tenant_id: id(1),
  project_id: id(2),
  scopes: ['data.operation.read', 'data.ingestion.write'],
  max_security_level: 'L0_PUBLIC',
  authz_version: 2,
  deadline: '2099-01-01T00:00:00Z',
};
function authority(
  row: unknown = eligible,
  snapshot: unknown = {
    mode: 'legacy',
    tenantId: id(1),
    projectId: id(2),
    actorId: id(3),
    purpose: 'candidate-review',
    now: '2026-10-08T00:00:00Z',
    revision: 0,
    grants: [],
  },
) {
  const statements: string[] = [];
  const result = createCandidateFollowupAssigneeAuthority(
    {
      connect() {
        return Promise.resolve({
          query<Row>(sql: string) {
            statements.push(sql);
            return Promise.resolve({
              rows: (row === null ? [] : [row]) as Row[],
              rowCount: row === null ? 0 : 1,
            });
          },
          release() {},
        });
      },
    },
    () => Promise.resolve({ rows: [{ snapshot }] }),
  );
  return { result, statements };
}
describe('current internal assignment eligibility', () => {
  it('reads existing active membership without inventing a target session', async () => {
    const { result, statements } = authority();
    const out = await result(id(3), sourceContext);
    expect(out?.actorId).toBe(id(3));
    expect(out?.actorType).toBe('human');
    expect(out?.maintainer).toBe(true);
    expect(out?.resourceScope).toBe(null);
    expect(statements.join('\n')).not.toMatch(
      /auth\.sessions|insert |update |delete /i,
    );
    expect(statements.join('\n')).toMatch(/membership.*expires_at/s);
  });
  it.each([
    null,
    { ...eligible, actor_type: 'agent' },
    { ...eligible, project_id: id(9) },
    { ...eligible, scopes: ['data.operation.read'] },
    { ...eligible, deadline: '2000-01-01T00:00:00Z' },
  ])('fails closed for unknown or ineligible targets', async (row) =>
    expect(await authority(row).result(id(3), sourceContext)).toBeNull(),
  );
  it('never falls back to broad membership if resource authority is unavailable', async () =>
    expect(
      await authority(eligible, null).result(id(3), sourceContext),
    ).toBeNull());
  it('rejects wrong-purpose or wrong-subject resource authority', async () =>
    expect(
      await authority(eligible, {
        mode: 'legacy',
        tenantId: id(1),
        projectId: id(2),
        actorId: id(4),
        purpose: 'other',
        now: '2026-10-08T00:00:00Z',
        revision: 0,
        grants: [],
      }).result(id(3), sourceContext),
    ).toBeNull());
});
describe('exact bounded followup transport contracts', () => {
  it.each(['create', 'get', 'list', 'act', 'review'])(
    'registers %s independently',
    (op) => {
      const cap =
        DATA_CAPABILITY_REGISTRY[
          `data.ingestion.candidate.followup.${op}` as keyof typeof DATA_CAPABILITY_REGISTRY
        ];
      expect(cap).toBeDefined();
      expect(cap?.executionMode).toBe('SYNCHRONOUS');
    },
  );
  it('accepts target identifier only and rejects client target authority', () => {
    const schema =
      DATA_CAPABILITY_REGISTRY[
        'data.ingestion.candidate.followup.act' as keyof typeof DATA_CAPABILITY_REGISTRY
      ]?.inputSchema;
    expect(
      schema?.safeParse({
        followupId: id(8),
        expectedVersion: 2,
        action: 'HANDOFF',
        targetActorId: id(3),
        note: '交接',
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        followupId: id(8),
        expectedVersion: 2,
        action: 'HANDOFF',
        targetActorId: id(3),
        targetType: 'human',
        target: { actorId: id(3), scopes: ['data.publish'] },
        note: '交接',
      }).success,
    ).toBe(false);
  });
});
