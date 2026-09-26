// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
  act,
} from '@testing-library/react';
import {
  ResourcePolicyProposalSchema,
  type ResourcePolicyRequestsPage,
} from '@wiser/platform-contracts';
import { ProjectSourcePolicies } from './project-source-policies';
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const row: ResourcePolicyRequestsPage['items'][number] = {
  id: id(3),
  projectId: id(1),
  policyId: id(5),
  expectedPolicyVersion: 0,
  resource: { kind: 'version', dataItemId: id(7), versionId: id(8) },
  allowedActions: ['content.read'],
  managementRoles: ['data-manager'],
  licenseBasis: '公开河流水文资料使用许可',
  startsAt: '2026-09-01T00:00:00Z',
  expiresAt: '2099-10-01T00:00:00Z',
  maxGrantDays: 7,
  reason: '公开资料研究与展示',
  applicantId: id(4),
  status: 'pending',
  version: 1,
  decidedBy: null,
  decisionReason: null,
  publishedVersion: null,
  createdAt: '2026-09-23T00:00:00Z',
  decidedAt: null,
  publicationState: 'none',
};
const page = (items = [row], canApprove = true) => ({
  items,
  hasMore: false,
  canPropose: true,
  canApprove,
  checkedAt: new Date().toISOString(),
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('separates publication history from revoked permission and prevents self review', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json(
          page([
            {
              ...row,
              status: 'published',
              publicationState: 'revoked',
              publishedVersion: 1,
              version: 2,
            },
          ]),
        ),
      ),
    ),
  );
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(4)} locale="zh-CN" />,
  );
  await screen.findByText('公开河流水文资料使用许可');
  expect(
    screen.getByText('已发布', { selector: '[data-status]' }),
  ).toBeDefined();
  expect(
    screen.getByText('已撤销', { selector: '[data-status]' }),
  ).toBeDefined();
  expect(screen.queryByRole('button', { name: '发布许可' })).toBeNull();
  expect(screen.queryByRole('button', { name: '撤销许可' })).toBeNull();
});
it('keeps uncertain retries idempotent, requires a reason and refreshes after independent approval', async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(init);
        return Promise.resolve(
          calls.length === 1
            ? Response.json({ code: 'ACCESS_UNAVAILABLE' }, { status: 503 })
            : Response.json({
                ...row,
                status: 'published',
                publicationState: undefined,
                version: 2,
                publishedVersion: 1,
              }),
        );
      }
      return Promise.resolve(Response.json(page()));
    }),
  );
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '发布许可' }));
  fireEvent.change(screen.getByLabelText('办理原因'), {
    target: { value: '核对原始许可，批准本次发布' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  await screen.findByText('许可已发布，成员授权另行办理。');
  expect(new Headers(calls[0].headers).get('idempotency-key')).toBe(
    new Headers(calls[1].headers).get('idempotency-key'),
  );
  expect(
    JSON.parse(typeof calls[1].body === 'string' ? calls[1].body : ''),
  ).toEqual({
    projectId: id(1),
    requestId: id(3),
    expectedVersion: 1,
    decision: 'publish',
    reason: '核对原始许可，批准本次发布',
  });
});
it('hides reviewer controls for the applicant even when a role can approve', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(page()))),
  );
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(4)} locale="zh-CN" />,
  );
  await screen.findByText('公开河流水文资料使用许可');
  expect(screen.queryByRole('button', { name: '发布许可' })).toBeNull();
  expect(screen.getByRole('button', { name: '撤回申请' })).toBeDefined();
});
it('discards a late previous project result and clears data on denial', async () => {
  let finish: ((r: Response) => void) | undefined;
  const fetch = vi.fn((url: string) =>
    url.includes(id(1))
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(
          Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 }),
        ),
  );
  vi.stubGlobal('fetch', fetch);
  const { rerender } = render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  rerender(
    <ProjectSourcePolicies projectId={id(9)} viewerId={id(2)} locale="zh-CN" />,
  );
  await screen.findByRole('alert');
  finish?.(Response.json(page()));
  await waitFor(() =>
    expect(screen.queryByText('公开河流水文资料使用许可')).toBeNull(),
  );
  expect(screen.queryByRole('button', { name: '发布许可' })).toBeNull();
});
it('does not offer revocation to an approval-only steward', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          ...page([
            {
              ...row,
              status: 'published',
              publicationState: 'active',
              publishedVersion: 1,
              version: 2,
            },
          ]),
          canPropose: false,
          canApprove: true,
        }),
      ),
    ),
  );
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  await screen.findByText('公开河流水文资料使用许可');
  expect(screen.queryByRole('button', { name: '撤销许可' })).toBeNull();
});
it('loads the bounded source catalog only when requested and submits the chosen fixed version', async () => {
  const first = {
    dataItemId: id(7),
    versionId: id(8),
    name: '永定河治理资料',
    sourceOrganization: '北京公开来源',
    versionNumber: 3,
    securityLevel: 'L0_PUBLIC',
    processingStage: 'ACCEPTED',
    publicationStatus: 'PUBLISHED',
    acceptanceStatus: 'PASSED',
    policyId: null,
    expectedPolicyVersion: 0,
  };
  const second = {
    ...first,
    dataItemId: id(9),
    versionId: id(10),
    sourceOrganization: '河北公开来源',
    versionNumber: 2,
    policyId: id(11),
    expectedPolicyVersion: 4,
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const { publicationState: _unused, ...proposalReceipt } = row;
  void _unused;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('management-catalog'))
        return Promise.resolve(
          Response.json({
            items: [first, second],
            hasMore: false,
            checkedAt: new Date().toISOString(),
            managementRoleOptions: ['data-manager', 'source-reviewer'],
          }),
        );
      if (url.includes('source-policy-propose'))
        return Promise.resolve(Response.json(proposalReceipt));
      return Promise.resolve(Response.json(page([])));
    }),
  );
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  await screen.findByText('暂无符合条件的来源许可申请。');
  expect(calls.some(({ url }) => url.includes('management-catalog'))).toBe(
    false,
  );
  fireEvent.click(screen.getByRole('button', { name: '登记来源许可' }));
  await screen.findByText(/河北公开来源 · 第2版/);
  expect(screen.getAllByText('永定河治理资料')).toHaveLength(2);
  fireEvent.click(
    screen.getByRole('button', { name: '选择河北公开来源的第2版' }),
  );
  fireEvent.click(screen.getByLabelText('内容查阅'));
  fireEvent.click(screen.getByLabelText('原件获取'));
  fireEvent.click(screen.getByLabelText('source-reviewer'));
  fireEvent.change(screen.getByLabelText('许可依据'), {
    target: { value: '公开资料使用与原件查阅许可' },
  });
  fireEvent.change(screen.getByLabelText('许可开始时间'), {
    target: { value: '2026-10-01T00:00' },
  });
  fireEvent.change(screen.getByLabelText('许可结束时间'), {
    target: { value: '2027-10-01T00:00' },
  });
  fireEvent.change(screen.getByLabelText('单次授权上限（天）'), {
    target: { value: '30' },
  });
  fireEvent.change(screen.getByLabelText('申请原因'), {
    target: { value: '核对公开资料来源与使用范围' },
  });
  fireEvent.click(screen.getByRole('button', { name: '提交来源许可申请' }));
  await screen.findByText('来源许可申请已提交，等待独立审批。');
  const submission = calls.find(({ url }) =>
    url.includes('source-policy-propose'),
  );
  expect(submission).toBeDefined();
  const body = submission?.init?.body;
  expect(typeof body).toBe('string');
  const command = ResourcePolicyProposalSchema.parse(
    JSON.parse(body as string) as unknown,
  );
  expect(command).toMatchObject({
    projectId: id(1),
    policyId: id(11),
    expectedPolicyVersion: 4,
    resource: { kind: 'version', dataItemId: id(9), versionId: id(10) },
    allowedActions: ['content.read', 'original.read'],
    managementRoles: ['source-reviewer'],
    maxGrantDays: 30,
    licenseBasis: '公开资料使用与原件查阅许可',
    reason: '核对公开资料来源与使用范围',
  });
});
it('does not offer source selection without proposal authority', async () => {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(
        url.includes('external-sources')
          ? {
              items: [],
              hasMore: false,
              checkedAt: '2026-09-23T00:00:00Z',
              managementRoleOptions: [],
              canPropose: false,
            }
          : { ...page([]), canPropose: false },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  await screen.findByText('暂无符合条件的来源许可申请。');
  expect(screen.queryByRole('button', { name: '登记来源许可' })).toBeNull();
  expect(
    fetch.mock.calls.some(([url]) => url.includes('management-catalog')),
  ).toBe(false);
});
it('searches and pages the management catalog without mixing a late earlier response', async () => {
  const resource = {
    dataItemId: id(7),
    versionId: id(8),
    name: '永定河公开资料',
    sourceOrganization: '公开来源',
    versionNumber: 1,
    securityLevel: 'L0_PUBLIC',
    processingStage: 'ACCEPTED',
    publicationStatus: 'PUBLISHED',
    acceptanceStatus: 'PASSED',
    policyId: null,
    expectedPolicyVersion: 0,
  };
  let finishOldPage: ((response: Response) => void) | undefined;
  const fetch = vi.fn((url: string) => {
    if (!url.includes('management-catalog'))
      return Promise.resolve(Response.json(page([])));
    const params = new URL(url, 'http://wiser.test').searchParams;
    if (params.get('search') === '永定河')
      return Promise.resolve(
        Response.json({
          items: [{ ...resource, name: '永定河公开资料' }],
          hasMore: false,
          checkedAt: new Date().toISOString(),
          managementRoleOptions: ['data-manager'],
        }),
      );
    if (params.get('offset') === '20')
      return new Promise<Response>((resolve) => {
        finishOldPage = resolve;
      });
    return Promise.resolve(
      Response.json({
        items: [resource],
        hasMore: true,
        checkedAt: new Date().toISOString(),
        managementRoleOptions: ['data-manager'],
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '登记来源许可' }));
  await screen.findByText('永定河公开资料');
  const catalog = screen.getByRole('region', { name: '选择资料版本' });
  fireEvent.click(within(catalog).getByRole('button', { name: '下一页' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) => String(url).includes('offset=20')),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText('资料名称或来源机构'), {
    target: { value: '永定河' },
  });
  fireEvent.click(screen.getByRole('button', { name: '查询资料' }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([url]) =>
        String(url).includes('search=%E6%B0%B8%E5%AE%9A%E6%B2%B3'),
      ),
    ).toBe(true),
  );
  act(() => {
    finishOldPage?.(
      Response.json({
        items: [{ ...resource, name: '过期的上一页结果' }],
        hasMore: false,
        checkedAt: new Date().toISOString(),
        managementRoleOptions: ['data-manager'],
      }),
    );
  });
  expect(screen.queryByText('过期的上一页结果')).toBeNull();
  expect(screen.getByText('永定河公开资料')).toBeDefined();
});
it('blocks a source request when no appointable management role is available', async () => {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(
        url.includes('management-catalog')
          ? {
              items: [
                {
                  dataItemId: id(7),
                  versionId: id(8),
                  name: '公开资料',
                  sourceOrganization: '公开来源',
                  versionNumber: 1,
                  securityLevel: 'L0_PUBLIC',
                  processingStage: 'ACCEPTED',
                  publicationStatus: 'PUBLISHED',
                  acceptanceStatus: 'PASSED',
                  policyId: null,
                  expectedPolicyVersion: 0,
                },
              ],
              hasMore: false,
              checkedAt: new Date().toISOString(),
              managementRoleOptions: [],
            }
          : page([]),
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectSourcePolicies projectId={id(1)} viewerId={id(2)} locale="zh-CN" />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '登记来源许可' }));
  fireEvent.click(
    await screen.findByRole('button', { name: '选择公开来源的第1版' }),
  );
  expect(
    screen.getByText('当前没有可选管理岗位，请联系项目管理员核对岗位设置。'),
  ).toBeDefined();
  expect(
    screen
      .getByRole('button', { name: '提交来源许可申请' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    fetch.mock.calls.every(
      ([url]) => !String(url).includes('source-policy-propose'),
    ),
  ).toBe(true);
});
