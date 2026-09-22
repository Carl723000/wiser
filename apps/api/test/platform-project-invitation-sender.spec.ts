import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invite: vi.fn(), create: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }));
import { createProjectInvitationSender } from '../src/platform/project-invitation-sender.js';
afterEach(() => vi.resetAllMocks());
it('uses a fixed configured website and returns only the invited identity', async () => {
  mocks.invite.mockResolvedValue({
    data: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        private_detail: 'hidden',
      },
    },
    error: null,
  });
  mocks.create.mockReturnValue({
    auth: { admin: { inviteUserByEmail: mocks.invite } },
  });
  const send = createProjectInvitationSender({
    supabaseUrl: 'https://auth.example.test',
    serviceRoleKey: 'server-only-test-key',
    webOrigin: 'https://wiser.example.test',
  });
  expect(await send('reader@example.test')).toEqual({
    actorId: '11111111-1111-4111-8111-111111111111',
  });
  expect(mocks.invite).toHaveBeenCalledWith('reader@example.test', {
    redirectTo: 'https://wiser.example.test/zh-CN/auth/invite',
  });
  expect(mocks.create.mock.calls[0]?.[2]).toMatchObject({
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
});
it('refuses arbitrary insecure destinations and hides provider error details', async () => {
  expect(() =>
    createProjectInvitationSender({
      supabaseUrl: 'https://auth.example.test',
      serviceRoleKey: 'x',
      webOrigin: 'http://outside.example.test',
    }),
  ).toThrow();
  mocks.create.mockReturnValue({
    auth: { admin: { inviteUserByEmail: mocks.invite } },
  });
  mocks.invite.mockResolvedValue({
    data: { user: null },
    error: { message: 'private provider details' },
  });
  const send = createProjectInvitationSender({
    supabaseUrl: 'http://127.0.0.1:56421',
    serviceRoleKey: 'server-only-test-key',
    webOrigin: 'http://localhost:3288',
  });
  await expect(send('reader@example.test')).rejects.toThrow(
    'Invitation delivery unavailable',
  );
});
