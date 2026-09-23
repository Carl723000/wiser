// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { ResourcePackageCommandSchema } from '@wiser/platform-contracts';
function body(value: RequestInit['body']) {
  if (typeof value !== 'string') throw new Error('Expected JSON body');
  return value;
}
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ProjectResourceDefinitions } from './project-resource-definitions';
const project = {
  projectId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  nameZh: '测试项目',
  nameEn: 'Test project',
  canManage: true,
  canApprove: true,
  requestsEnabled: true,
  resourceAccessEnabled: true,
  memberStatus: 'active',
  expiresAt: null,
  roles: ['manager'],
  assignableRoles: [],
};
const preset = {
  kind: 'preset',
  id: '33333333-3333-4333-8333-333333333333',
  version: 2,
  name: '研究查阅',
  actions: ['content.read'],
  maxDays: 30,
  approvalLevel: 'ordinary',
  createdAt: '2026-09-23T00:00:00Z',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('lists existing presets and creates a new immutable version without authorizing anyone', async () => {
  const calls: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(init);
        return Promise.resolve(
          Response.json({
            kind: 'preset',
            id: preset.id,
            version: 3,
            authorityRevision: 4,
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          items: [preset],
          hasMore: false,
          authorityRevision: 3,
        }),
      );
    }),
  );
  render(
    <StrictMode>
      <ProjectResourceDefinitions
        project={project}
        locale="zh-CN"
        kind="preset"
      />
    </StrictMode>,
  );
  await screen.findByText('研究查阅');
  fireEvent.click(screen.getByRole('button', { name: '创建新版本' }));
  fireEvent.change(screen.getByLabelText('办理原因'), {
    target: { value: '调整研究查阅期限' },
  });
  fireEvent.change(screen.getByLabelText('最长期限（天）'), {
    target: { value: '20' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存预设' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(JSON.parse(body(calls[0]?.body))).toMatchObject({
    projectId: project.projectId,
    presetId: preset.id,
    expectedVersion: 2,
    maxDays: 20,
    actions: ['content.read'],
  });
  expect(screen.getByRole('status').textContent).toContain('未授予成员权限');
});
it('discards a late old-project response and clears visible definitions after permission failure', async () => {
  let resolveOld!: (value: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [{ ...preset, name: '当前项目预设' }],
        hasMore: false,
        authorityRevision: 4,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 }),
    );
  vi.stubGlobal('fetch', fetch);
  const view = render(
    <ProjectResourceDefinitions
      project={project}
      locale="zh-CN"
      kind="preset"
    />,
  );
  view.rerender(
    <ProjectResourceDefinitions
      project={{
        ...project,
        projectId: '44444444-4444-4444-8444-444444444444',
      }}
      locale="zh-CN"
      kind="preset"
    />,
  );
  await screen.findByText('当前项目预设');
  resolveOld(
    Response.json({ items: [preset], hasMore: false, authorityRevision: 3 }),
  );
  expect(screen.queryByText('研究查阅')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新清单' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('当前项目预设')).toBeNull();
});
it('does not request definitions for a non-manager or a project without resource management', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const view = render(
    <ProjectResourceDefinitions
      project={{ ...project, canManage: false }}
      locale="en"
      kind="preset"
    />,
  );
  expect(screen.queryByRole('button', { name: 'Create preset' })).toBeNull();
  view.rerender(
    <ProjectResourceDefinitions
      project={{ ...project, resourceAccessEnabled: false }}
      locale="en"
      kind="preset"
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('selects exact resource versions and reuses the same idempotency key after an uncertain save', async () => {
  const calls: RequestInit[] = [];
  const source = {
    dataItemId: project.tenantId,
    versionId: preset.id,
    name: '公开水质月报',
    provider: '公开发布单位',
    kind: 'DATASET',
    assetCount: 1,
    readiness: {
      records: 'READY',
      spatial: 'NO_SPATIAL_DATA',
      graph: 'NOT_PARSED',
    },
    recordCount: 120,
    featureCount: null,
    limitations: [],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(init);
        if (calls.length === 1) return Promise.reject(new Error('network'));
        return Promise.resolve(
          Response.json({
            kind: 'package',
            id: ResourcePackageCommandSchema.parse(JSON.parse(body(init.body)))
              .packageId,
            version: 1,
            authorityRevision: 5,
          }),
        );
      }
      if (String(url).includes('resource-definitions'))
        return Promise.resolve(
          Response.json({ items: [], hasMore: false, authorityRevision: 4 }),
        );
      return Promise.resolve(
        Response.json({
          queryId: project.projectId,
          spec: {},
          createdAt: '2026-09-23T00:00:00Z',
          expiresAt: '2099-09-23T00:30:00Z',
          view: 'resources',
          totalCount: 1,
          resources: [source],
        }),
      );
    }),
  );
  render(
    <StrictMode>
      <ProjectResourceDefinitions
        project={project}
        locale="zh-CN"
        kind="package"
      />
    </StrictMode>,
  );
  await screen.findByText('暂无符合条件的定义。');
  fireEvent.click(screen.getByRole('button', { name: '创建资源包' }));
  await screen.findByText('公开水质月报');
  fireEvent.click(screen.getByRole('button', { name: '加入资源包' }));
  fireEvent.click(screen.getByRole('button', { name: '加入资源包' }));
  expect(screen.getAllByRole('button', { name: '移出资源包' })).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('名称'), {
    target: { value: '公开资料查阅包' },
  });
  fireEvent.change(screen.getByLabelText('许可依据'), {
    target: { value: '公开资料研究使用许可' },
  });
  fireEvent.change(screen.getByLabelText('办理原因'), {
    target: { value: '课题研究资料查阅' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存资源包' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '保存资源包' }));
  await screen.findByRole('status');
  expect(calls).toHaveLength(2);
  expect(calls[1]?.headers).toEqual(calls[0]?.headers);
  expect(calls[1]?.body).toEqual(calls[0]?.body);
  expect(JSON.parse(body(calls[1]?.body))).toMatchObject({
    projectId: project.projectId,
    expectedVersion: 0,
    resources: [
      {
        kind: 'version',
        dataItemId: source.dataItemId,
        versionId: source.versionId,
      },
    ],
    allowedActions: ['content.read'],
  });
});
