import 'server-only';
import {
  DataFoundationApiError,
  type DataFoundationWebConfig,
} from './data-foundation-dal.server';
import type { VerifiedSessionClient } from './supabase/verified-session';

export interface CandidateOriginalProxyOptions {
  readonly request: Request;
  readonly ingestionId: string;
  readonly processingBatchId: string;
  readonly assetId: string;
  readonly config: DataFoundationWebConfig;
  readonly createAuthClient: () => Promise<VerifiedSessionClient | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

export function proxyCandidateOriginal(
  _options: CandidateOriginalProxyOptions,
): Promise<Response> {
  return Promise.reject(new DataFoundationApiError('unavailable', 503));
}
