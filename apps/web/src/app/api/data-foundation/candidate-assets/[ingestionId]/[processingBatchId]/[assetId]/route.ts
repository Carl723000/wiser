import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DataFoundationApiError,
  loadDataFoundationWebConfig,
  type DataFoundationAuthClient,
} from '@/lib/data-foundation-dal.server';
import { proxyCandidateOriginal } from '@/lib/candidate-original-proxy.server';
import { createWiserServerSupabaseClient } from '@/lib/supabase/server';
import { getDictionary, isLocale } from '@/lib/i18n';

async function handle(
  request: Request,
  context: {
    params: Promise<{
      ingestionId: string;
      processingBatchId: string;
      assetId: string;
    }>;
  },
) {
  try {
    const config = loadDataFoundationWebConfig(process.env);
    if (!config) throw new DataFoundationApiError('configuration', 503);
    return await proxyCandidateOriginal({
      request,
      ...(await context.params),
      config,
      createAuthClient: AsyncLocalStorage.bind(
        async () =>
          (await createWiserServerSupabaseClient()) as DataFoundationAuthClient | null,
      ),
    });
  } catch (error) {
    const locale = new URL(request.url).searchParams.get('locale');
    const dictionary = getDictionary(
      isLocale(locale ?? '') ? (locale as 'en' | 'zh-CN') : 'zh-CN',
    );
    return new Response(
      request.method === 'HEAD'
        ? null
        : dictionary.dataFoundation.explorer.unavailable,
      {
        status: error instanceof DataFoundationApiError ? error.status : 503,
        headers: {
          'cache-control': 'private, no-store',
          'content-type': 'text/plain; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "sandbox; default-src 'none'; frame-ancestors 'none'",
        },
      },
    );
  }
}

export const GET = handle;
export const HEAD = handle;
