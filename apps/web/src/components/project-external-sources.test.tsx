// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ProjectExternalSources } from './project-external-sources';
import { ResourcePolicyProposalSchema } from '@wiser/platform-contracts';

const id = 'e3000000-0000-4000-8000-000000000001';
const item = {
  sourceId: id,
  name: '合成站点目录',
  provider: '合成供方',
  providerPermissionStatus: 'VERIFIED',
  allowedFields: ['stationCode', 'year'],
  allowedActions: ['source.discover', 'external.directory'],
  fromYear: 2020,
  toYear: 2025,
  expiresAt: '2099-01-01T00:00:00Z',
  licenseBasis: 'Synthetic provider permission',
  eligibleForProposal: true,
  connectionStatus: 'UNKNOWN',
  wiserPolicyStatus: 'none',
  policyId: null,
  expectedPolicyVersion: 0,
};
const page = (items: unknown[]) => ({
  items,
  hasMore: false,
  checkedAt: '2026-09-23T00:00:00Z',
  managementRoleOptions: ['data-steward'],
  canPropose: true,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows no application control when no trusted registry returns a source', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(page([])))),
  );
  render(<ProjectExternalSources projectId={id} locale="zh-CN" />);
  expect(
    await screen.findByText('暂无已登记且可管理的外部来源。'),
  ).toBeDefined();
  expect(screen.queryByRole('button', { name: '登记来源许可' })).toBeNull();
});

it('shows separate supplier, WISER and connection states and submits only a selected source', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        init?.method === 'POST'
          ? Response.json({
              id,
              projectId: id,
              policyId: id,
              expectedPolicyVersion: 0,
              resource: { kind: 'external-source', sourceId: id },
              allowedActions: ['source.discover'],
              managementRoles: ['data-steward'],
              licenseBasis: 'Synthetic provider permission',
              startsAt: '2026-09-23T00:00:00Z',
              expiresAt: '2026-10-23T00:00:00Z',
              maxGrantDays: 30,
              reason: 'Synthetic request reason',
              applicantId: id,
              status: 'pending',
              version: 1,
              decidedBy: null,
              decisionReason: null,
              publishedVersion: null,
              createdAt: '2026-09-23T00:00:00Z',
              decidedAt: null,
            })
          : Response.json(page([item])),
      );
    }),
  );
  render(<ProjectExternalSources projectId={id} locale="zh-CN" />);
  expect(await screen.findByText('合成站点目录')).toBeDefined();
  expect(screen.getByText('供方许可')).toBeDefined();
  expect(screen.getByText('WISER 来源许可')).toBeDefined();
  expect(screen.getByText('连接核验')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: '登记来源许可' }));
  fireEvent.click(screen.getByLabelText('来源发现'));
  fireEvent.click(screen.getByLabelText('data-steward'));
  fireEvent.change(screen.getByLabelText('许可开始时间'), {
    target: { value: '2026-09-23T08:00' },
  });
  fireEvent.change(screen.getByLabelText('许可结束时间'), {
    target: { value: '2026-10-23T08:00' },
  });
  fireEvent.change(screen.getByLabelText('申请原因'), {
    target: { value: 'Synthetic request reason' },
  });
  fireEvent.click(screen.getByRole('button', { name: '提交来源许可申请' }));
  await waitFor(() =>
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(true),
  );
  const raw: unknown = JSON.parse(
    calls.find((call) => call.init?.method === 'POST')!.init!.body as string,
  );
  const command = ResourcePolicyProposalSchema.parse(raw);
  expect(command.resource).toEqual({ kind: 'external-source', sourceId: id });
  expect(command.allowedActions).toEqual(['source.discover']);
  expect(command.licenseBasis).toBe('Synthetic provider permission');
  expect(JSON.stringify(command)).not.toContain('url');
});

it('disables registration when the supplier permission is revoked', async () => {
  const revoked = {
    ...item,
    providerPermissionStatus: 'REVOKED',
    eligibleForProposal: false,
    allowedActions: [],
    allowedFields: [],
    fromYear: null,
    toYear: null,
    licenseBasis: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(page([revoked])))),
  );
  render(<ProjectExternalSources projectId={id} locale="zh-CN" />);
  expect(await screen.findByText('合成站点目录')).toBeDefined();
  expect(screen.queryByRole('button', { name: '登记来源许可' })).toBeNull();
});
