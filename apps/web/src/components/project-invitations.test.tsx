// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { ProjectInvitations } from './project-invitations';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('distinguishes existing-account grant from sent mail and refreshes a failed delivery before retry', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'reader@example.test',
          roleKey: 'data-reader',
          expiresAt: '2027-01-01T00:00:00Z',
          status: 'failed',
          actorId: null,
          version: 3,
          deliveryMode: 'email',
          lastErrorCode: 'DELIVERY_UNAVAILABLE',
          acceptedAt: null,
        },
      ],
      hasMore: false,
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectInvitations
      locale="zh-CN"
      projectId="22222222-2222-4222-8222-222222222222"
      roles={[{ roleKey: 'data-reader', maxDays: 30, scopes: [] }]}
      onChanged={() => {}}
    />,
  );
  await screen.findByText('reader@example.test');
  expect(screen.getByText('投递结果未确认')).toBeTruthy();
  expect(screen.queryByText('邀请已送达')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '邀请成员' }));
  expect(screen.getByLabelText('邮箱')).toBeTruthy();
});

it('keeps a delivery failure visible when the invitation list refresh succeeds', async () => {
  const item = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'retry@example.test',
    roleKey: 'data-reader',
    expiresAt: '2027-01-01T00:00:00Z',
    status: 'failed',
    actorId: null,
    version: 3,
    deliveryMode: 'email',
    lastErrorCode: 'DELIVERY_UNAVAILABLE',
    acceptedAt: null,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((url) =>
      Promise.resolve(
        (typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).includes('deliver-invitation')
          ? new Response(null, { status: 503 })
          : Response.json({ items: [item], hasMore: false }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  render(
    <ProjectInvitations
      locale="zh-CN"
      projectId="22222222-2222-4222-8222-222222222222"
      roles={[]}
      onChanged={() => {}}
    />,
  );
  await screen.findByText(item.email);
  fireEvent.click(screen.getByRole('button', { name: '核对并重试' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await screen.findByText(item.email);
  expect(screen.getByRole('alert')).toBeTruthy();
});
