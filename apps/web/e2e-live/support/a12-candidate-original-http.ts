import { createHash } from 'node:crypto';
import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {
  IngestionCandidateReferenceSchema,
  Sha256Schema,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  CandidateLoadTransportError,
  type LoadFailure,
} from './a12-candidate-load-driver.ts';
import type { CandidateLoadHttpOptions } from './a12-candidate-load-http.ts';

export type CandidateOriginalHttpOptions = CandidateLoadHttpOptions;
export interface CandidateOriginalHttpInput {
  readonly reference: IngestionCandidateReference;
  readonly assetId: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
}
export interface CandidateOriginalHttpResult {
  readonly status: 200;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface CandidateOriginalHttpAdapter {
  readonly read: (
    input: CandidateOriginalHttpInput,
  ) => Promise<CandidateOriginalHttpResult>;
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 30_000;
const signalDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
);
function fail(kind: LoadFailure): never {
  throw new CandidateLoadTransportError(kind);
}
function plain(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    ) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && keys.includes(key),
    ) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, 'value'),
    )
  );
}
function isAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (typeof signalDescriptor?.get !== 'function') return fail('invalid');
  return signalDescriptor.get.call(signal) === true;
}
function config(
  value: CandidateOriginalHttpOptions,
): CandidateOriginalHttpOptions {
  try {
    if (
      !plain(value, [
        'apiOrigin',
        'taskApiPort',
        'tenantId',
        'projectId',
        'purpose',
        'accessToken',
        'signal',
      ]) ||
      typeof value.apiOrigin !== 'string'
    )
      return fail('invalid');
    const origin = new URL(value.apiOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      (value.apiOrigin !== origin.origin &&
        value.apiOrigin !== origin.origin + '/') ||
      !Number.isInteger(value.taskApiPort) ||
      value.taskApiPort < 1 ||
      value.taskApiPort > 65535 ||
      Number(origin.port || 80) !== value.taskApiPort ||
      !PlatformUuidSchema.safeParse(value.tenantId).success ||
      !PlatformUuidSchema.safeParse(value.projectId).success ||
      !PlatformPurposeSchema.safeParse(value.purpose).success ||
      typeof value.accessToken !== 'function' ||
      (value.signal !== undefined && !(value.signal instanceof AbortSignal))
    )
      return fail('invalid');
    // Check the native signal brand without reading a caller-provided getter.
    isAborted(value.signal);
    return Object.freeze({
      apiOrigin: origin.origin,
      taskApiPort: value.taskApiPort,
      tenantId: value.tenantId,
      projectId: value.projectId,
      purpose: value.purpose,
      accessToken: value.accessToken,
      ...(value.signal ? { signal: value.signal } : {}),
    });
  } catch {
    return fail('invalid');
  }
}
function admitted(
  value: CandidateOriginalHttpInput,
): CandidateOriginalHttpInput {
  try {
    if (
      !plain(value, [
        'reference',
        'assetId',
        'expectedSha256',
        'expectedSizeBytes',
      ]) ||
      !plain(value.reference, [
        'kind',
        'ingestionId',
        'processingBatchId',
        'reviewHash',
      ]) ||
      !PlatformUuidSchema.safeParse(value.assetId).success ||
      !Sha256Schema.safeParse(value.expectedSha256).success ||
      !Number.isSafeInteger(value.expectedSizeBytes) ||
      value.expectedSizeBytes < 1 ||
      value.expectedSizeBytes > MAX_ORIGINAL_BYTES
    )
      return fail('invalid');
    const reference = IngestionCandidateReferenceSchema.safeParse(
      value.reference,
    );
    if (!reference.success) return fail('invalid');
    return Object.freeze({
      reference: Object.freeze(reference.data),
      assetId: value.assetId,
      expectedSha256: value.expectedSha256,
      expectedSizeBytes: value.expectedSizeBytes,
    });
  } catch {
    return fail('invalid');
  }
}
function tokenFailure(error: unknown): LoadFailure {
  try {
    if (!(error instanceof CandidateLoadTransportError)) return 'unavailable';
    const kind: unknown = Object.getOwnPropertyDescriptor(error, 'kind')?.value;
    return kind === 'denied' || kind === 'stale' || kind === 'cancelled'
      ? kind
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
function networkFailure(error: unknown): LoadFailure {
  try {
    const code: unknown =
      error !== null && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    return typeof code === 'string' && code.startsWith('HPE_')
      ? 'invalid'
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
function statusFailure(status: number): LoadFailure {
  if (status === 401 || status === 403) return 'denied';
  if ([404, 409, 410].includes(status)) return 'stale';
  if ((status >= 200 && status < 400) || [413, 415, 422].includes(status))
    return 'invalid';
  return 'unavailable';
}

/** Raw original integrity only; never a scanner or formal A12 certificate. */
export function createCandidateOriginalHttpAdapter(
  options: CandidateOriginalHttpOptions,
): CandidateOriginalHttpAdapter {
  const fixed = config(options);
  const agent = new Agent({ keepAlive: false, maxSockets: 8 });
  const pending = new Set<() => void>();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    for (const cancel of [...pending]) cancel();
    // Cleanup never replaces a previously settled safe failure.
    try {
      agent.destroy();
    } catch {
      // Retain the first safe result if native cleanup throws.
    }
  }
  const read: CandidateOriginalHttpAdapter['read'] = (input) => {
    if (closed || isAborted(fixed.signal))
      return Promise.reject(new CandidateLoadTransportError('cancelled'));
    let expected: CandidateOriginalHttpInput;
    try {
      expected = admitted(input);
    } catch {
      return Promise.reject(new CandidateLoadTransportError('invalid'));
    }
    // Existing GET/HEAD content route in rest-module.ts; this adapter permits
    // GET only, one reviewHash query and no arbitrary URL/HEAD/Range selector.
    const path = `/api/data/v1/tenants/${fixed.tenantId}/projects/${fixed.projectId}/ingestions/${expected.reference.ingestionId}/candidates/${expected.reference.processingBatchId}/assets/${expected.assetId}/content?reviewHash=${expected.reference.reviewHash}`;
    return new Promise<CandidateOriginalHttpResult>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const cancel = () => finish('cancelled');
      const abort = () => {
        finish('cancelled');
        close();
      };
      const timer = setTimeout(() => {
        finish('unavailable');
        close();
      }, DEADLINE_MS);
      pending.add(cancel);
      function finish(
        kind: LoadFailure | null,
        result?: CandidateOriginalHttpResult,
      ) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        // Use native methods so a signal's own method/accessor cannot inject
        // a raw cleanup exception or replace the first recorded cause.
        if (fixed.signal) {
          try {
            EventTarget.prototype.removeEventListener.call(
              fixed.signal,
              'abort',
              abort,
            );
          } catch {
            // Retain the first safe result if native cleanup throws.
          }
        }
        try {
          response?.removeAllListeners('data');
          response?.removeAllListeners('end');
        } catch {
          // Retain the first safe result if native cleanup throws.
        }
        try {
          response?.destroy();
        } catch {
          // Retain the first safe result if native cleanup throws.
        }
        try {
          request?.destroy();
        } catch {
          // Retain the first safe result if native cleanup throws.
        }
        if (kind !== null) reject(new CandidateLoadTransportError(kind));
        else if (result !== undefined) resolve(Object.freeze(result));
        else reject(new CandidateLoadTransportError('unavailable'));
      }
      if (fixed.signal) {
        try {
          EventTarget.prototype.addEventListener.call(
            fixed.signal,
            'abort',
            abort,
            { once: true },
          );
        } catch {
          finish('unavailable');
          return;
        }
      }
      if (closed || isAborted(fixed.signal)) {
        abort();
        return;
      }
      void Promise.resolve()
        .then(fixed.accessToken)
        .then((token) => {
          if (settled) return;
          if (
            typeof token !== 'string' ||
            token.length === 0 ||
            Buffer.byteLength(token) > 16384 ||
            [...token].some(
              (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126,
            )
          ) {
            finish('denied');
            return;
          }
          request = httpRequest(
            fixed.apiOrigin + path,
            {
              method: 'GET',
              agent,
              headers: {
                Accept: 'application/octet-stream',
                'Accept-Encoding': 'identity',
                Authorization: `Bearer ${token}`,
                'X-WISER-Tenant-ID': fixed.tenantId,
                'X-WISER-Project-ID': fixed.projectId,
                'X-WISER-Purpose': fixed.purpose,
              },
            },
            (incoming) => {
              response = incoming;
              incoming.on('error', () => finish('unavailable'));
              incoming.on('aborted', () => finish('unavailable'));
              incoming.on('close', () => {
                if (!settled) finish('unavailable');
              });
              if (settled) {
                incoming.destroy();
                return;
              }
              if (incoming.statusCode !== 200) {
                finish(statusFailure(incoming.statusCode ?? 0));
                return;
              }
              const length = incoming.headers['content-length'];
              const encoding = incoming.headers['content-encoding'];
              if (
                incoming.headers['content-range'] !== undefined ||
                incoming.headers['transfer-encoding'] !== undefined ||
                (encoding !== undefined &&
                  encoding.toLowerCase() !== 'identity') ||
                typeof length !== 'string' ||
                !/^\d+$/.test(length) ||
                !Number.isSafeInteger(Number(length)) ||
                Number(length) !== expected.expectedSizeBytes
              ) {
                finish('invalid');
                return;
              }
              const hash = createHash('sha256');
              let sizeBytes = 0;
              incoming.on('data', (chunk: Buffer) => {
                if (settled) return;
                if (
                  !Buffer.isBuffer(chunk) ||
                  sizeBytes + chunk.length > expected.expectedSizeBytes ||
                  sizeBytes + chunk.length > MAX_ORIGINAL_BYTES
                ) {
                  finish('invalid');
                  return;
                }
                sizeBytes += chunk.length;
                try {
                  hash.update(chunk);
                } catch {
                  finish('unavailable');
                }
              });
              incoming.on('end', () => {
                if (settled) return;
                if (!incoming.complete) {
                  finish('unavailable');
                  return;
                }
                if (
                  sizeBytes !== expected.expectedSizeBytes ||
                  sizeBytes !== Number(length)
                ) {
                  finish('invalid');
                  return;
                }
                try {
                  const sha256 = hash.digest('hex');
                  if (sha256 !== expected.expectedSha256) {
                    finish('drift');
                    return;
                  }
                  finish(null, { status: 200, sha256, sizeBytes });
                } catch {
                  finish('unavailable');
                }
              });
            },
          );
          request.on('error', (error) => finish(networkFailure(error)));
          request.end();
        })
        .catch((error: unknown) => finish(tokenFailure(error)));
    });
  };
  return {
    read,
    close,
    diagnostics: () => ({ activeRequests: pending.size, closed }),
  };
}
