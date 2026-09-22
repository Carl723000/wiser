// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { ProjectResourceGrants } from './project-resource-grants';
const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const project = {
  projectId: id(1),
  tenantId: id(2),
  nameZh: '研究项目',
  nameEn: 'Research',
  canManage: true,
  canApprove: true,
  requestsEnabled: true,
  resourceAccessEnabled: true,
  memberStatus: 'active',
  expiresAt: null,
  roles: ['manager'],
  assignableRoles: [],
};
const grant = {
  id: id(3),
  actorId: id(4),
  packageId: id(5),
  packageVersion: 1,
  packageName: '水文资料',
  presetId: id(6),
  presetVersion: 1,
  presetName: '研究查阅',
  actions: ['content.read'],
  resourceCount: 2,
  purpose: 'web-console',
  startsAt: '2026-09-23T00:00:00Z',
  expiresAt: '2026-09-30T00:00:00Z',
  status: 'active',
  revokedAt: null,
  reason: '研究任务许可',
  revocationReason: null,
  createdBy: id(7),
  approvedBy: id(8),
};
const page = () =>
  Response.json({
    items: [grant],
    hasMore: false,
    checkedAt: '2026-09-23T00:00:00Z',
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows own records without management controls and labels stored state separately from actual access', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(page())),
  );
  render(
    <ProjectResourceGrants
      project={{ ...project, canManage: false }}
      viewerId={id(4)}
      locale="zh-CN"
    />,
  );
  await screen.findByText('水文资料');
  expect(screen.getByText('有效期内')).toBeDefined();
  expect(screen.queryByRole('button', { name: '撤销本项授权' })).toBeNull();
  expect(screen.queryByRole('button', { name: '申请续期' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '授权记录说明' }));
  expect(screen.getByText(/实际访问仍需通过成员状态/)).toBeDefined();
});
it('retries an uncertain selective revocation with the same key and reports remaining independent grants', async () => {
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
                grantId: grant.id,
                revokedAt: '2026-09-23T00:00:00Z',
                alreadyRevoked: false,
                otherActiveGrantCount: 1,
              }),
        );
      }
      return Promise.resolve(page());
    }),
  );
  render(
    <ProjectResourceGrants project={project} viewerId={id(4)} locale="zh-CN" />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '撤销本项授权' }));
  fireEvent.change(screen.getByLabelText('办理原因'), {
    target: { value: '任务结束，撤销本项授权' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await screen.findByText('本项授权已撤销');
  expect(screen.getByText('其他有效期内的独立授权记录：1')).toBeDefined();
  expect(new Headers(calls[0]?.headers).get('idempotency-key')).toBe(
    new Headers(calls[1]?.headers).get('idempotency-key'),
  );
  expect(JSON.parse(String(calls[1]?.body))).toMatchObject({
    projectId: id(1),
    grantId: grant.id,
  });
});
it('discards a previous project response after switching projects', async () => {
  let resolve: ((r: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.includes(id(1))
        ? new Promise<Response>((r) => {
            resolve = r;
          })
        : Promise.resolve(
            Response.json({
              items: [],
              hasMore: false,
              checkedAt: '2026-09-23T00:00:00Z',
            }),
          ),
    ),
  );
  const view = render(
    <ProjectResourceGrants project={project} viewerId={id(4)} locale="zh-CN" />,
  );
  view.rerender(
    <ProjectResourceGrants
      project={{ ...project, projectId: id(9) }}
      viewerId={id(4)}
      locale="zh-CN"
    />,
  );
  await screen.findByText('暂无符合条件的授权记录。');
  resolve?.(page());
  await waitFor(() => expect(screen.queryByText('水文资料')).toBeNull());
});
