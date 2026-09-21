import { isSameOriginRequest } from './request-origin';
import {
  readVerifiedAuthViewer,
  safeLocalizedRedirect,
  type WiserWebAuthClient,
} from './auth';
import type { Locale } from './i18n';

export interface AccountAuthClient extends WiserWebAuthClient {
  readonly auth: WiserWebAuthClient['auth'] & {
    verifyOtp(input: {
      readonly type: 'invite';
      readonly token_hash: string;
    }): Promise<{ readonly error: unknown }>;
    getUser(): Promise<{
      readonly error: unknown;
      readonly data: { readonly user: { readonly id: string } | null };
    }>;
    updateUser(input: {
      readonly password: string;
    }): Promise<{ readonly error: unknown }>;
  };
}

const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
} as const;

export function validInvitationHash(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{32,256}$/i.test(value);
}

function one(form: FormData, name: string): string | null {
  const values = form.getAll(name);
  return values.length === 1 && typeof values[0] === 'string'
    ? values[0]
    : null;
}

function redirect(target: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...HEADERS, Location: target },
  });
}

function protectedPost(request: Request): Response | null {
  if (request.method !== 'POST')
    return new Response(null, {
      status: 405,
      headers: { ...HEADERS, Allow: 'POST' },
    });
  if (!request.headers.has('origin') || !isSameOriginRequest(request)) {
    return new Response(null, { status: 403, headers: HEADERS });
  }
  return null;
}

async function form(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

function withNext(target: string, next: string, locale: Locale): string {
  if (next === `/${locale}`) return target;
  return `${target}${target.includes('?') ? '&' : '?'}${new URLSearchParams({ next })}`;
}

async function clearSession(client: AccountAuthClient): Promise<boolean> {
  try {
    return (await client.auth.signOut({ scope: 'local' })).error === null;
  } catch {
    return false;
  }
}

export function createAccountRouteService(options: {
  readonly createClient: () => Promise<AccountAuthClient | null>;
}) {
  async function client(): Promise<AccountAuthClient | null> {
    try {
      return await options.createClient();
    } catch {
      return null;
    }
  }
  return {
    async accept(request: Request, locale: Locale): Promise<Response> {
      const rejected = protectedPost(request);
      if (rejected) return rejected;
      const data = await form(request);
      const hash = one(data, 'token_hash');
      const failure = () => redirect(`/${locale}/auth/invite?reason=invalid`);
      if (!validInvitationHash(hash)) return failure();
      const c = await client();
      if (!c) return redirect(`/${locale}/auth/invite?reason=unavailable`);
      try {
        const result = await c.auth.verifyOtp({
          type: 'invite',
          token_hash: hash,
        });
        if (result.error !== null) return failure();
        if (!(await readVerifiedAuthViewer(c))) {
          await clearSession(c);
          return failure();
        }
        const next = safeLocalizedRedirect(one(data, 'next'), locale);
        return redirect(withNext(`/${locale}/account/password`, next, locale));
      } catch {
        return failure();
      }
    },

    async password(request: Request, locale: Locale): Promise<Response> {
      const rejected = protectedPost(request);
      if (rejected) return rejected;
      const data = await form(request);
      const next = safeLocalizedRedirect(one(data, 'next'), locale);
      const password = one(data, 'password');
      if (
        !password ||
        password.length < 12 ||
        password.length > 4096 ||
        password !== one(data, 'confirmation')
      ) {
        return redirect(
          withNext(`/${locale}/account/password?reason=fields`, next, locale),
        );
      }
      const c = await client();
      const sessionFailure = () => redirect(`/${locale}/login?reason=session`);
      if (!c) return sessionFailure();
      try {
        const viewer = await readVerifiedAuthViewer(c);
        const current = viewer ? await c.auth.getUser() : null;
        if (
          !viewer ||
          current?.error !== null ||
          current.data.user?.id !== viewer.userId
        ) {
          await clearSession(c);
          return sessionFailure();
        }
      } catch {
        await clearSession(c);
        return sessionFailure();
      }
      try {
        const result = await c.auth.updateUser({ password });
        if (result.error !== null)
          return redirect(
            withNext(
              `/${locale}/account/password?reason=unavailable`,
              next,
              locale,
            ),
          );
      } catch {
        return redirect(
          withNext(
            `/${locale}/account/password?reason=unavailable`,
            next,
            locale,
          ),
        );
      }
      if (!(await clearSession(c)))
        return redirect(
          withNext(`/${locale}/account/password?reason=signout`, next, locale),
        );
      return redirect(withNext(`/${locale}/login?passwordSet=1`, next, locale));
    },
  };
}
