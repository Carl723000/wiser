// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import type { ResourcePolicyRequestsPage } from '@wiser/platform-contracts';
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
