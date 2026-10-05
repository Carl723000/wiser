// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  account: vi.fn(),
  load: vi.fn(),
}));
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(url);
  },
}));
vi.mock('@/lib/auth', () => ({ readVerifiedAuthViewer: mocks.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createWiserServerSupabaseClient: () => Promise.resolve({}),
}));
vi.mock('@/lib/agent-connections.server', () => ({
  getAgentConnectionAccount: mocks.account,
}));
import Page, { metadata } from '../app/[locale]/account/agents/page';
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function props(locale = 'zh-CN', result?: string) {
  return {
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve({ result }),
  };
}
const registeredRange = {
  scopes: ['data.catalog.read'],
  purpose: 'agent-data',
  maxSecurityLevel: 'L1_INTERNAL',
} as const;
it('requires a verified login before reading owned connections', async () => {
  mocks.viewer.mockResolvedValue(null);
  await expect(Page(props())).rejects.toThrow(
    '/zh-CN/login?next=%2Fzh-CN%2Faccount%2Fagents',
  );
  expect(mocks.account).not.toHaveBeenCalled();
});
it('does not turn an unavailable ownership service into an empty list', async () => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockRejectedValue(new Error('private-token-upstream'));
  render(await Page(props()));
  expect(screen.getByRole('alert').textContent).toContain('暂时无法');
  expect(screen.queryByText('private-token-upstream')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});
it('retains a retry for partial provider revocation and treats client names as text', async () => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockResolvedValue({ load: mocks.load });
  mocks.load.mockResolvedValue([
    {
      ...registeredRange,
      connectionId: 'owned',
      clientName: '<a href="https://outside.test">client</a>',
      projectName: null,
      expiresAt: '2026-09-26T10:00:00Z',
      status: 'revoked',
      providerConsent: true,
    },
  ]);
  render(await Page(props('en', 'provider-pending')));
  expect(screen.getByRole('alert').textContent).toContain('Access has stopped');
  expect(
    screen.getByRole('button', { name: 'Finish disconnecting' }),
  ).toBeDefined();
  expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(
    '<a href=',
  );
  expect(document.querySelector('a[href="https://outside.test"]')).toBeNull();
  expect(document.querySelector('input[name="clientId"]')).toBeNull();
  expect(metadata.referrer).toBe('same-origin');
});
it('shows the disconnect action only while either access or saved consent remains', async () => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockResolvedValue({ load: mocks.load });
  const base = {
    ...registeredRange,
    clientName: null,
    projectName: { 'zh-CN': '河流项目', en: 'River project' },
    expiresAt: '2026-09-26T10:00:00Z',
    providerConsent: false,
  };
  mocks.load.mockResolvedValue([
    { ...base, connectionId: 'active', status: 'active' },
    { ...base, connectionId: 'revoked', status: 'revoked' },
  ]);
  render(await Page(props('zh-CN', 'disconnected')));
  expect(screen.getAllByRole('button', { name: '断开连接' })).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toContain('连接已断开');
});
it('shows an active connection without a fixed expiry without promising perpetual access', async () => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockResolvedValue({ load: mocks.load });
  mocks.load.mockResolvedValue([
    {
      ...registeredRange,
      connectionId: 'active',
      clientName: 'Codex',
      projectName: { 'zh-CN': '黑臭水体', en: 'Black-odor water' },
      expiresAt: null,
      status: 'active',
      providerConsent: true,
    },
  ]);
  render(await Page(props('zh-CN')));
  expect(screen.getByText('未设置固定期限；可手动断开')).toBeDefined();
  expect(screen.queryByText('1970')).toBeNull();
});

it.each([
  {
    locale: 'zh-CN',
    conditions: '当前连接条件',
    met: '成员条件已满足；具体资料仍须判权',
    member: '本人当前成员状态',
    role: '本人当前有效角色',
    expiry: '成员有效期',
    active: '有效',
    readRole: '资料查询',
    noExpiry: '未设置期限',
  },
  {
    locale: 'en',
    conditions: 'Current connection conditions',
    met: 'Membership conditions met; data access still requires a check',
    member: 'My current membership',
    role: 'My current effective roles',
    expiry: 'Membership term',
    active: 'Active',
    readRole: 'Data reader',
    noExpiry: 'No expiry set',
  },
])(
  'reads current membership separately from the ceiling in $locale',
  async (copy) => {
    mocks.viewer.mockResolvedValue({ userId: 'owner' });
    mocks.account.mockResolvedValue({ load: mocks.load });
    mocks.load.mockResolvedValue([
      {
        ...registeredRange,
        connectionId: 'current',
        clientName: 'Current client',
        projectName: { 'zh-CN': '河流', en: 'River' },
        expiresAt: null,
        status: 'active',
        providerConsent: true,
        projectAccess: {
          state: 'loaded',
          memberStatus: 'active',
          roles: ['data-reader'],
          expiresAt: null,
        },
      },
    ]);
    render(await Page(props(copy.locale)));
    const region = within(
      screen.getByRole('region', { name: 'Current client' }),
    );
    for (const label of [
      copy.conditions,
      copy.met,
      copy.member,
      copy.role,
      copy.expiry,
      copy.active,
      copy.readRole,
      copy.noExpiry,
    ])
      expect(region.getByText(label)).toBeDefined();
  },
);

it.each([
  ['not-loaded', '本次尚未查到该项目；请重新加载或前往访问管理核对。'],
  ['not-visible', '该项目当前不在你的可见范围；请联系项目管理员核对。'],
  ['unavailable', '暂时无法核对项目成员条件；请重新加载后再试。'],
] as const)(
  'does not conflate %s with loss of access',
  async (state, label) => {
    mocks.viewer.mockResolvedValue({ userId: 'owner' });
    mocks.account.mockResolvedValue({ load: mocks.load });
    mocks.load.mockResolvedValue([
      {
        ...registeredRange,
        connectionId: 'unknown',
        clientName: 'Unknown client',
        projectName: null,
        expiresAt: null,
        status: 'active',
        providerConsent: true,
        projectAccess: { state },
      },
    ]);
    render(await Page(props()));
    expect(screen.getByText(label)).toBeDefined();
    expect(screen.getByText('当前成员条件尚未确认')).toBeDefined();
    expect(screen.getByRole('button', { name: '断开连接' })).toBeDefined();
    expect(
      screen.getByRole('link', { name: '查看我的访问' }).getAttribute('href'),
    ).toBe('/zh-CN/account/access');
  },
);

it('keeps an expired membership and its exact term visible without removing disconnect', async () => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockResolvedValue({ load: mocks.load });
  mocks.load.mockResolvedValue([
    {
      ...registeredRange,
      connectionId: 'expired-member',
      clientName: 'Expired member',
      projectName: { 'zh-CN': '河流', en: 'River' },
      expiresAt: null,
      status: 'active',
      providerConsent: true,
      projectAccess: {
        state: 'loaded',
        memberStatus: 'active',
        roles: [],
        expiresAt: '2026-01-01T00:00:00Z',
      },
    },
  ]);
  render(await Page(props()));
  expect(screen.getByText('成员已到期')).toBeDefined();
  expect(
    screen.getByText('成员期限已到，当前无法通过此连接访问'),
  ).toBeDefined();
  expect(
    document.querySelector('time[datetime="2026-01-01T00:00:00Z"]'),
  ).toBeDefined();
  expect(screen.getByRole('button', { name: '断开连接' })).toBeDefined();
});

it.each([
  {
    locale: 'zh-CN',
    scopesLabel: '登记操作范围',
    purposeLabel: '登记用途',
    purpose: 'AI/MCP 数据工作',
    levelLabel: '最高资料级别',
    internal: '内部',
    restricted: '受限',
    catalog: '查阅资料目录',
    query: '查询资料记录',
    search: '检索资料',
    knowledge: '查阅知识',
    graph: '查阅关系图',
    geo: '查询空间资料',
    operation: '查看处理进度',
    intake: '提交与维护接入资料',
    boundary:
      '登记范围是授权上限；实际操作仍需核查当前项目权限、资料许可和授权期限。',
  },
  {
    locale: 'en',
    scopesLabel: 'Registered actions',
    purposeLabel: 'Registered purpose',
    purpose: 'AI/MCP data work',
    levelLabel: 'Highest data level',
    internal: 'Internal',
    restricted: 'Restricted',
    catalog: 'Read the data catalog',
    query: 'Query data records',
    search: 'Search data',
    knowledge: 'Read knowledge',
    graph: 'Read relationship graphs',
    geo: 'Query spatial data',
    operation: 'View processing progress',
    intake: 'Submit and maintain intake materials',
    boundary:
      'The registered scope is an authorization ceiling. Each action still requires current project access, data permission and an unexpired authorization.',
  },
])('reads only each connection’s registered range in $locale', async (copy) => {
  mocks.viewer.mockResolvedValue({ userId: 'owner' });
  mocks.account.mockResolvedValue({ load: mocks.load });
  mocks.load.mockResolvedValue([
    {
      ...registeredRange,
      connectionId: 'reader',
      clientName: 'Read client',
      projectName: null,
      scopes: [
        'data.catalog.read',
        'data.query.execute',
        'data.search.execute',
        'data.knowledge.read',
        'data.graph.read',
        'data.geo.read',
        'data.operation.read',
      ],
      expiresAt: null,
      status: 'active',
      providerConsent: true,
    },
    {
      ...registeredRange,
      connectionId: 'intake',
      clientName: 'Intake client',
      projectName: null,
      scopes: ['data.ingestion.write'],
      maxSecurityLevel: 'L2_RESTRICTED',
      expiresAt: null,
      status: 'active',
      providerConsent: true,
    },
  ]);
  render(await Page(props(copy.locale)));
  const reader = within(screen.getByRole('region', { name: 'Read client' }));
  const intake = within(screen.getByRole('region', { name: 'Intake client' }));
  expect(reader.getByText(copy.scopesLabel)).toBeDefined();
  expect(reader.getByText(copy.purposeLabel)).toBeDefined();
  expect(reader.getByText(copy.purpose)).toBeDefined();
  expect(reader.getByText(copy.levelLabel)).toBeDefined();
  expect(reader.getByText(copy.internal)).toBeDefined();
  for (const action of [
    copy.catalog,
    copy.query,
    copy.search,
    copy.knowledge,
    copy.graph,
    copy.geo,
    copy.operation,
  ]) {
    expect(reader.getByText(action)).toBeDefined();
    expect(intake.queryByText(action)).toBeNull();
  }
  expect(reader.queryByText(copy.intake)).toBeNull();
  expect(intake.getByText(copy.intake)).toBeDefined();
  expect(intake.getByText(copy.restricted)).toBeDefined();
  expect(reader.getByText(copy.boundary)).toBeDefined();
  expect(intake.getByText(copy.boundary)).toBeDefined();
});

it.each(['zh-CN', 'en'])(
  'keeps unknown registered scopes as plain text without broadening actions in %s',
  async (locale) => {
    mocks.viewer.mockResolvedValue({ userId: 'owner' });
    mocks.account.mockResolvedValue({ load: mocks.load });
    mocks.load.mockResolvedValue([
      {
        ...registeredRange,
        connectionId: 'future',
        clientName: 'Future client',
        scopes: ['data.future.read', 'constructor'],
        projectName: null,
        expiresAt: null,
        status: 'active',
        providerConsent: true,
      },
    ]);
    render(await Page(props(locale)));
    const region = within(
      screen.getByRole('region', { name: 'Future client' }),
    );
    expect(region.getByText('data.future.read')).toBeDefined();
    expect(region.getByText('constructor')).toBeDefined();
    expect(
      region.getAllByRole('listitem').map((item) => item.textContent),
    ).toEqual(['data.future.read', 'constructor']);
    expect(region.queryByText('查阅资料目录')).toBeNull();
    expect(region.queryByText('Read the data catalog')).toBeNull();
    expect(region.queryByRole('link')).toBeNull();
  },
);

it.each([
  { status: 'active', label: '授权有效', level: 'L0_PUBLIC', value: '公开' },
  {
    status: 'expired',
    label: '授权已到期',
    level: 'L2_RESTRICTED',
    value: '受限',
  },
  {
    status: 'revoked',
    label: '已断开',
    level: 'L3_CONFIDENTIAL',
    value: '保密',
  },
])(
  'keeps the registered ceiling separate from $status state',
  async (state) => {
    mocks.viewer.mockResolvedValue({ userId: 'owner' });
    mocks.account.mockResolvedValue({ load: mocks.load });
    mocks.load.mockResolvedValue([
      {
        ...registeredRange,
        connectionId: state.status,
        clientName: 'Registered client',
        projectName: null,
        maxSecurityLevel: state.level,
        expiresAt: '2026-09-26T10:00:00Z',
        status: state.status,
        providerConsent: false,
      },
    ]);
    render(await Page(props()));
    expect(screen.getByText(state.label)).toBeDefined();
    expect(screen.getByText(state.value)).toBeDefined();
    expect(screen.getByText('登记用途')).toBeDefined();
    expect(screen.getByText('AI/MCP 数据工作')).toBeDefined();
    expect(screen.queryByRole('button') === null).toBe(
      state.status === 'revoked',
    );
  },
);
