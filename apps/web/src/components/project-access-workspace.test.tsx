// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ProjectAccessWorkspace } from './project-access-workspace';
const project = {
  projectId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  nameZh: '京津冀测试项目',
  nameEn: 'Water test project',
  canManage: false,
  canApprove: false,
  requestsEnabled: true,
  memberStatus: 'active',
  expiresAt: null,
  roles: ['data-reader'],
  assignableRoles: [
    { roleKey: 'data-reader', maxDays: 30, scopes: ['data.catalog.read'] },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows personal access without presenting member controls to an ordinary reader', () => {
  render(
    <ProjectAccessWorkspace
      locale="zh-CN"
      initial={{ items: [project], hasMore: false }}
      environmentLabel="本机演示"
    />,
  );
  expect(screen.getByRole('heading', { name: '我的访问' })).toBeTruthy();
  expect(screen.getByText('京津冀测试项目')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '成员与权限' })).toBeNull();
});
it('loads the selected project members and clears them when authorization is withdrawn', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            actorId: '33333333-3333-4333-8333-333333333333',
            displayName: 'Sample reader',
            email: 'reader@example.test',
            status: 'active',
            version: 1,
            expiresAt: null,
            protected: false,
            roles: [{ roleKey: 'data-reader', expiresAt: null }],
          },
        ],
        hasMore: false,
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 }),
    );
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    typeof input === 'string' && input.includes('/invitations?')
      ? Promise.resolve(Response.json({ items: [], hasMore: false }))
      : fetch(input, init),
  );
  render(
    <ProjectAccessWorkspace
      locale="en"
      initial={{ items: [{ ...project, canManage: true }], hasMore: false }}
      environmentLabel="Local demonstration"
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Members & permissions' }),
  );
  await screen.findByText('reader@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh members' }));
  await waitFor(() =>
    expect(screen.queryByText('reader@example.test')).toBeNull(),
  );
  expect(screen.getByRole('alert').textContent).toContain('permission');
});

it('does not present an active membership without effective roles as usable access', () => {
  render(
    <ProjectAccessWorkspace
      locale="zh-CN"
      initial={{ items: [{ ...project, roles: [] }], hasMore: false }}
      environmentLabel="本机演示"
    />,
  );
  expect(screen.queryByText('有效', { exact: true })).toBeNull();
});
