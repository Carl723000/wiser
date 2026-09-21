import { describe, expect, it, vi } from 'vitest';

import { createAccountRouteService } from './auth-invitation';

const ID = 'd1000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const PASSWORD = 'synthetic-password-only';

function client() {
  return {
    auth: {
      signInWithPassword: vi.fn(),
      exchangeCodeForSession: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
      getClaims: vi.fn(async () => ({
        error: null,
        data: {
          claims: {
            sub: ID,
            session_id: 'd1000000-0000-4000-8000-000000000002',
            role: 'authenticated',
            exp: 2_000_000_000,
          },
        },
      })),
      getUser: vi.fn(async () => ({ error: null, data: { user: { id: ID } } })),
      verifyOtp: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: null })),
    },
  };
}

function post(
  values: Record<string, string>,
  origin: string | null = 'https://wiser.test',
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return new Request('https://wiser.test/zh-CN/auth/accept', {
    method: 'POST',
    body,
    headers: origin ? { Origin: origin } : {},
  });
}

describe('invitation acceptance and own password', () => {
  it('consumes only an explicitly submitted invite and strips the token from redirects', async () => {
    const c = client();
    const service = createAccountRouteService({ createClient: async () => c });
    const result = await service.accept(
      post({ token_hash: HASH, next: '/zh-CN/data-foundation' }),
      'zh-CN',
    );
    expect(c.auth.verifyOtp).toHaveBeenCalledWith({
      type: 'invite',
      token_hash: HASH,
    });
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe(
      '/zh-CN/account/password?next=%2Fzh-CN%2Fdata-foundation',
    );
    expect(result.headers.get('location')).not.toContain(HASH);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it.each([null, 'https://attacker.test', 'null'])(
    'rejects a missing or foreign Origin (%s) before touching auth',
    async (origin) => {
      const c = client();
      const service = createAccountRouteService({
        createClient: async () => c,
      });
      expect(
        (await service.accept(post({ token_hash: HASH }, origin), 'zh-CN'))
          .status,
      ).toBe(403);
      expect(
        (
          await service.password(
            post({ password: PASSWORD, confirmation: PASSWORD }, origin),
            'zh-CN',
          )
        ).status,
      ).toBe(403);
      expect(c.auth.verifyOtp).not.toHaveBeenCalled();
      expect(c.auth.updateUser).not.toHaveBeenCalled();
    },
  );

  it('does not consume an invitation on GET and rejects malformed or ambiguous fields', async () => {
    const c = client();
    const service = createAccountRouteService({ createClient: async () => c });
    expect(
      (
        await service.accept(
          new Request(
            'https://wiser.test/zh-CN/auth/accept?token_hash=' + HASH,
          ),
          'zh-CN',
        )
      ).status,
    ).toBe(405);
    for (const token of ['', 'invalid', 'a'.repeat(513)]) {
      const r = await service.accept(post({ token_hash: token }), 'zh-CN');
      expect(r.headers.get('location')).toBe(
        '/zh-CN/auth/invite?reason=invalid',
      );
    }
    const body = new FormData();
    body.append('token_hash', HASH);
    body.append('token_hash', HASH);
    await service.accept(
      new Request('https://wiser.test/zh-CN/auth/accept', {
        method: 'POST',
        headers: { Origin: 'https://wiser.test' },
        body,
      }),
      'zh-CN',
    );
    expect(c.auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('never lets a replay, expiry, or provider failure look accepted', async () => {
    const c = client();
    c.auth.verifyOtp.mockRejectedValueOnce(
      new Error('private upstream details'),
    );
    const r = await createAccountRouteService({
      createClient: async () => c,
    }).accept(post({ token_hash: HASH }), 'en');
    expect(r.headers.get('location')).toBe('/en/auth/invite?reason=invalid');
    expect(await r.text()).not.toContain('private upstream');
  });

  it('fails closed for an unverifiable invitation session', async () => {
    const c = client();
    c.auth.getClaims.mockRejectedValueOnce(new Error('unavailable'));
    const r = await createAccountRouteService({
      createClient: async () => c,
    }).accept(post({ token_hash: HASH }), 'en');
    expect(r.headers.get('location')).toBe('/en/auth/invite?reason=invalid');
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('updates only the live current user, ignores forged identity/grants, and requires sign-in afterward', async () => {
    const c = client();
    const r = await createAccountRouteService({
      createClient: async () => c,
    }).password(
      post({
        password: PASSWORD,
        confirmation: PASSWORD,
        userId: 'another-user',
        role: 'admin',
        next: '//attacker.test',
      }),
      'zh-CN',
    );
    expect(c.auth.updateUser).toHaveBeenCalledWith({ password: PASSWORD });
    expect(c.auth.getUser).toHaveBeenCalledOnce();
    expect(c.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(r.headers.get('location')).toBe('/zh-CN/login?passwordSet=1');
  });

  it.each([
    ['', ''],
    ['short', 'short'],
    [PASSWORD, 'different'],
    ['x'.repeat(4097), 'x'.repeat(4097)],
  ])(
    'rejects invalid password inputs without updating a user',
    async (password, confirmation) => {
      const c = client();
      const r = await createAccountRouteService({
        createClient: async () => c,
      }).password(post({ password, confirmation }), 'en');
      expect(c.auth.updateUser).not.toHaveBeenCalled();
      expect(r.headers.get('location')).toBe(
        '/en/account/password?reason=fields',
      );
    },
  );

  it('rejects a revoked or mismatched live user despite locally valid claims', async () => {
    const c = client();
    c.auth.getUser.mockResolvedValueOnce({
      error: null,
      data: { user: { id: 'different' } },
    });
    const r = await createAccountRouteService({
      createClient: async () => c,
    }).password(post({ password: PASSWORD, confirmation: PASSWORD }), 'en');
    expect(c.auth.updateUser).not.toHaveBeenCalled();
    expect(r.headers.get('location')).toBe('/en/login?reason=session');
  });

  it('retains an actionable retry on password-provider failure and never echoes credentials', async () => {
    const c = client();
    c.auth.updateUser.mockRejectedValueOnce(new Error(PASSWORD));
    const r = await createAccountRouteService({
      createClient: async () => c,
    }).password(post({ password: PASSWORD, confirmation: PASSWORD }), 'en');
    expect(r.headers.get('location')).toBe(
      '/en/account/password?reason=unavailable',
    );
    expect(await r.text()).not.toContain(PASSWORD);
  });

  it('does not use an administrative fallback when auth is unavailable', async () => {
    const service = createAccountRouteService({
      createClient: async () => null,
    });
    expect(
      (await service.accept(post({ token_hash: HASH }), 'en')).headers.get(
        'location',
      ),
    ).toBe('/en/auth/invite?reason=unavailable');
    expect(
      (
        await service.password(
          post({ password: PASSWORD, confirmation: PASSWORD }),
          'en',
        )
      ).headers.get('location'),
    ).toBe('/en/login?reason=session');
  });
});
