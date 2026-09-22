// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ProjectAccessRequests } from './project-access-requests';
const viewer = '33333333-3333-4333-8333-333333333333';
const project = {
  projectId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  nameZh: '测试项目',
  nameEn: 'Test project',
  canManage: false,
  canApprove: true,
  requestsEnabled: true,
  memberStatus: 'active',
  expiresAt: null,
  roles: [],
  assignableRoles: [
    { roleKey: 'data-reader', maxDays: 30, scopes: ['data.catalog.read'] },
  ],
};
const item = {
  id: '44444444-4444-4444-8444-444444444444',
  projectId: project.projectId,
  applicantId: '55555555-5555-4555-8555-555555555555',
  applicantEmail: 'applicant@example.test',
  roleKey: 'data-reader',
  expiresAt: '2027-01-01T00:00:00Z',
  reason: 'Read approved evidence',
  version: 1,
  status: 'pending',
  decidedBy: null,
  decisionReason: null,
  decidedAt: null,
  lastErrorCode: null,
  accessState: 'none',
  createdAt: '2026-09-22T00:00:00Z',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps a failed decision visible after refreshing the queue and submits only its current version', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>((_input, init) =>
    Promise.resolve(
      init?.method === 'POST'
        ? Response.json({ code: 'VERSION_CONFLICT' }, { status: 409 })
        : Response.json({ items: [item], hasMore: false }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectAccessRequests
      locale="en"
      project={project}
      viewerId={viewer}
      review
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve request' }),
  );
  fireEvent.change(document.querySelector('textarea')!, {
    target: { value: 'Read-only evidence review' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('record changed'),
  );
  const posted = fetch.mock.calls.find((x) => x[1]?.method === 'POST')!;
  expect(JSON.parse(posted[1]!.body as string)).toEqual({
    projectId: project.projectId,
    requestId: item.id,
    expectedVersion: 1,
    decision: 'approve',
    reason: 'Read-only evidence review',
  });
  expect(posted[1]?.headers).toHaveProperty('idempotency-key');
  expect(screen.queryByText('The outcome has been updated.')).toBeNull();
});
it('shows an applicant cancellation for an unexecuted approval without exposing grant execution', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          items: [{ ...item, status: 'approved', decidedBy: viewer }],
          hasMore: false,
        }),
      ),
    ),
  );
  render(
    <ProjectAccessRequests
      locale="en"
      project={{ ...project, canApprove: false }}
      viewerId={item.applicantId}
    />,
  );
  expect(
    await screen.findByRole('button', { name: 'Withdraw request' }),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Apply grant' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve request' })).toBeNull();
});
it('clears stale rows on a denied refresh instead of leaving another applicant visible', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [item], hasMore: false }))
    .mockResolvedValueOnce(
      Response.json({ code: 'NOT_AUTHORIZED' }, { status: 403 }),
    );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectAccessRequests
      locale="en"
      project={project}
      viewerId={viewer}
      review
    />,
  );
  await screen.findByText(item.applicantEmail);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh requests' }));
  await waitFor(() =>
    expect(screen.queryByText(item.applicantEmail)).toBeNull(),
  );
  expect(await screen.findByRole('alert')).toBeTruthy();
});
it('does not present a historical successful grant as current access after revocation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          items: [
            {
              ...item,
              status: 'effective',
              accessState: 'revoked',
              decidedBy: viewer,
            },
          ],
          hasMore: false,
        }),
      ),
    ),
  );
  render(
    <ProjectAccessRequests
      locale="en"
      project={project}
      viewerId={viewer}
      review
    />,
  );
  expect(await screen.findByText('Revoked')).toBeTruthy();
  expect(screen.getByText('Grant completed')).toBeTruthy();
  expect(screen.queryByText('This grant is active')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply grant' })).toBeNull();
});
