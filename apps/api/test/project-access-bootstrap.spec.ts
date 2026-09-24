import { describe, expect, it } from 'vitest';
import { buildProjectAccessBootstrapPlan } from '../src/platform/project-access-bootstrap.js';

const input = {
  sourceProjectSlug: 'yongding-lab',
  demo: {
    slug: 'access-demo',
    nameZh: '权限演示',
    nameEn: 'Access demo',
    managerEmail: 'first@example.test',
    approverEmail: 'second@example.test',
    applicantEmail: 'third@example.test',
    expiresAt: '2026-10-01T00:00:00.000Z',
  },
  researcher: {
    email: 'researcher@example.test',
    expiresAt: '2026-10-24T00:00:00.000Z',
  },
  intake: {
    slug: 'black-odor-trial',
    nameZh: '黑臭水体试录入',
    nameEn: 'Black odor trial intake',
    expiresAt: '2026-10-24T00:00:00.000Z',
  },
};

describe('project access bootstrap plan', () => {
  it('separates the three demo duties and keeps the source project untouched', () => {
    const plan = buildProjectAccessBootstrapPlan(input, '2026-09-24T00:00:00.000Z');
    expect(plan.projects.map((project) => project.slug)).toEqual([
      'access-demo',
      'black-odor-trial',
    ]);
    expect(plan.assignments.filter((item) => item.projectSlug === 'access-demo')).toEqual([
      {
        projectSlug: 'access-demo',
        email: 'first@example.test',
        roleKey: 'access-demo-manager',
        expiresAt: input.demo.expiresAt,
      },
      {
        projectSlug: 'access-demo',
        email: 'second@example.test',
        roleKey: 'access-demo-approver',
        expiresAt: input.demo.expiresAt,
      },
      {
        projectSlug: 'access-demo',
        email: 'third@example.test',
        roleKey: 'data-project-preview',
        expiresAt: input.demo.expiresAt,
      },
    ]);
    expect(plan.assignments.filter((item) => item.projectSlug === 'yongding-lab')).toEqual([
      {
        projectSlug: 'yongding-lab',
        email: 'researcher@example.test',
        roleKey: 'researcher-read-delegate',
        expiresAt: input.researcher.expiresAt,
      },
    ]);
    expect(plan.roles.find((role) => role.key === 'access-demo-manager')?.scopes).toEqual([
      'platform.membership.manage',
    ]);
    expect(plan.roles.find((role) => role.key === 'access-demo-approver')?.scopes).toEqual([
      'platform.access.approve',
    ]);
    expect(plan.roles.find((role) => role.key === 'researcher-read-delegate')?.scopes).toContain(
      'platform.delegation.manage',
    );
    expect(plan.roles.find((role) => role.key === 'intake-submitter')?.scopes).toContain(
      'data.ingestion.write',
    );
    expect(plan.roles.flatMap((role) => role.scopes)).not.toContain('data.publish');
    expect(plan.roles.flatMap((role) => role.scopes)).not.toContain(
      'platform.project.manage',
    );
    for (const role of plan.roles.filter((item) =>
      ['researcher-read-delegate', 'intake-submitter'].includes(item.key),
    )) {
      expect(role.scopes).not.toContain('platform.membership.manage');
      expect(role.scopes).not.toContain('platform.access.approve');
    }
  });

  it('rejects shared demo identities and appointments longer than seven days', () => {
    expect(() =>
      buildProjectAccessBootstrapPlan(
        {
          ...input,
          demo: { ...input.demo, approverEmail: input.demo.managerEmail },
        },
        '2026-09-24T00:00:00.000Z',
      ),
    ).toThrow();
    expect(() =>
      buildProjectAccessBootstrapPlan(input, '2026-09-01T00:00:00.000Z'),
    ).toThrow();
  });
});
