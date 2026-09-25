import { PlatformAgentAuthorizationIdSchema } from '@wiser/platform-contracts';

export function GET(request: Request) {
  const authorizationId = new URL(request.url).searchParams.get(
    'authorization_id',
  );
  if (!PlatformAgentAuthorizationIdSchema.safeParse(authorizationId).success) {
    return new Response(null, {
      status: 400,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  const query = new URLSearchParams({ authorization_id: authorizationId! });
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/zh-CN/oauth/consent?${query}`,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
