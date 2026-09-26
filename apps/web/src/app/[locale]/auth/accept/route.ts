import { createAccountRouteService } from '@/lib/auth-invitation';
import { isLocale } from '@/lib/i18n';
import { createWiserServerSupabaseClient } from '@/lib/supabase/server';

const service = createAccountRouteService({
  createClient: createWiserServerSupabaseClient,
});
export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly locale: string }> },
) {
  const { locale } = await context.params;
  if (!isLocale(locale))
    return new Response(null, {
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  return service.accept(request, locale);
}
