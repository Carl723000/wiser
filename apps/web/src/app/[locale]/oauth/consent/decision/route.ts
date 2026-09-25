import { PlatformAgentAuthorizationIdSchema } from '@wiser/platform-contracts';

import {
  decideAgentConsent,
  type AgentConsentDecision,
} from '@/lib/agent-consent';
import { getAgentConsentServerContext } from '@/lib/agent-consent.server';
import { isLocale } from '@/lib/i18n';

interface Context {
  readonly params: Promise<{ readonly locale: string }>;
}

const noStore = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};

function back(locale: string, id: string | null, error: string): Response {
  const query = new URLSearchParams({ error });
  if (id !== null && PlatformAgentAuthorizationIdSchema.safeParse(id).success) {
    query.set('authorization_id', id);
  }
  return new Response(null, {
    status: 303,
    headers: { ...noStore, Location: `/${locale}/oauth/consent?${query}` },
  });
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const { locale } = await context.params;
  if (!isLocale(locale))
    return new Response(null, { status: 404, headers: noStore });
  const origin = request.headers.get('origin');
  const expectedOrigin =
    process.env.WISER_PUBLIC_WEB_ORIGIN ??
    (process.env.NODE_ENV === 'production'
      ? null
      : new URL(request.url).origin);
  if (origin === null || expectedOrigin === null || origin !== expectedOrigin) {
    return new Response(null, { status: 403, headers: noStore });
  }
  let form: FormData;
  try {
    if (Number(request.headers.get('content-length') ?? '0') > 16_384) {
      return new Response(null, { status: 413, headers: noStore });
    }
    form = await request.formData();
  } catch {
    return back(locale, null, 'invalid-request');
  }
  const authorizationId = form.get('authorization_id');
  if (
    typeof authorizationId !== 'string' ||
    !PlatformAgentAuthorizationIdSchema.safeParse(authorizationId).success
  ) {
    return back(locale, null, 'invalid-request');
  }
  const action = form.get('decision');
  let decision: AgentConsentDecision;
  if (action === 'deny') {
    decision = { authorizationId, decision: 'deny' };
  } else if (action === 'approve') {
    const duration = Number(form.get('expiresInSeconds'));
    decision = {
      authorizationId,
      decision: 'approve',
      tenantId: textField(form, 'tenantId'),
      projectId: textField(form, 'projectId'),
      mode: textField(form, 'mode') as 'query',
      maxSecurityLevel: textField(form, 'maxSecurityLevel') as 'L0_PUBLIC',
      expiresInSeconds: duration,
    };
  } else {
    return back(locale, authorizationId, 'invalid-request');
  }
  try {
    const { deps, token } = await getAgentConsentServerContext();
    const destination = await decideAgentConsent(deps, token, decision);
    return new Response(null, {
      status: 303,
      headers: { ...noStore, Location: destination },
    });
  } catch {
    return back(locale, authorizationId, 'unavailable');
  }
}
