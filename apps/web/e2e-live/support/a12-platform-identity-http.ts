import { CandidateLoadTransportError } from './a12-candidate-load-driver.ts';
import type { CandidateLoadMeInput } from './a12-candidate-load-auth.ts';

export interface A12PlatformIdentityHttpOptions {
  readonly apiOrigin: string;
  readonly taskApiPort: number;
  readonly signal?: AbortSignal;
}
export interface A12PlatformIdentityHttp {
  readonly readMe: (
    input: CandidateLoadMeInput,
  ) => Promise<{ readonly status: number; readonly body: unknown }>;
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

/** Red checkpoint: the existing identity HTTP consumer is not wired yet. */
export function createA12PlatformIdentityHttp(
  _options: A12PlatformIdentityHttpOptions,
): A12PlatformIdentityHttp {
  let closed = false;
  return Object.freeze({
    readMe: () =>
      Promise.reject(new CandidateLoadTransportError('unavailable')),
    close: () => {
      closed = true;
    },
    diagnostics: () => ({ activeRequests: 0, closed }),
  });
}
