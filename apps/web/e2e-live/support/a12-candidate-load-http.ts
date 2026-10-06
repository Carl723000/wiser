import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { DATA_CAPABILITY_REGISTRY } from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
  type LoadFailure,
  type LoadPorts,
  type LoadReply,
  type LoadRequest,
} from './a12-candidate-load-driver.ts';

export interface CandidateLoadHttpOptions {
  readonly apiOrigin: string;
  /** Exact API port from an already admitted task-owned manifest; no discovery. */
  readonly taskApiPort: number;
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
  /** Closure over an already verified session. This adapter never logs in. */
  readonly accessToken: () => Promise<string>;
  readonly signal?: AbortSignal;
}
export interface CandidateLoadHttpAdapter {
  readonly send: LoadPorts['send'];
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

const DEADLINE_MS = 30_000;
function fail(kind: LoadFailure): never {
  throw new CandidateLoadTransportError(kind);
}
function dataObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    ) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, 'value'),
    )
  );
}
function config(value: CandidateLoadHttpOptions): CandidateLoadHttpOptions {
  try {
    if (!dataObject(value)) return fail('invalid');
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
function requestPath(value: LoadRequest): string {
  try {
    if (
      !dataObject(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'method',
            'action',
            'reference',
            'first',
            'assetId',
            'after',
          ].includes(key),
      ) ||
      value.method !== 'GET' ||
      !['get', 'records', 'geometry'].includes(value.action) ||
      ![50, 200].includes(value.first)
    )
      return fail('invalid');
    const definition =
      DATA_CAPABILITY_REGISTRY[`data.ingestion.candidate.${value.action}`];
    if (definition.restMapping.method !== 'GET') return fail('invalid');
    const input = definition.inputSchema.safeParse({
      ...value.reference,
      first: value.first,
      ...(value.assetId === undefined ? {} : { assetId: value.assetId }),
      ...(value.after === undefined ? {} : { after: value.after }),
    });
    if (!input.success) return fail('invalid');
    if (value.after !== undefined && value.after.length > 2048)
      return fail('invalid');
    if (!dataObject(input.data)) return fail('invalid');
    let path: string = definition.restMapping.path;
    const query = new URLSearchParams();
    for (const [key, field] of Object.entries(input.data)) {
      if (typeof field !== 'string' && typeof field !== 'number')
        return fail('invalid');
      if (path.includes(`:${key}`))
        path = path.replace(`:${key}`, encodeURIComponent(String(field)));
      else if (field !== undefined) query.set(key, String(field));
    }
    return `${path}?${query}`;
  } catch {
    return fail('invalid');
  }
}
function networkFailure(error: unknown): LoadFailure {
  // Parser codes are inspected as data, never copied to results or error text.
  const code =
    error !== null && typeof error === 'object'
      ? (Object.getOwnPropertyDescriptor(error, 'code')?.value as unknown)
      : undefined;
  return typeof code === 'string' && code.startsWith('HPE_')
    ? 'invalid'
    : 'unavailable';
}
function sessionFailure(error: unknown): LoadFailure {
  try {
    if (!(error instanceof CandidateLoadTransportError)) return 'unavailable';
    const kind: unknown = Object.getOwnPropertyDescriptor(error, 'kind')?.value;
    return kind === 'denied' || kind === 'cancelled' || kind === 'stale'
      ? kind
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Raw test transport only. Auth/source admission remains outside the timed GET. */
export function createCandidateLoadHttpAdapter(
  options: CandidateLoadHttpOptions,
): CandidateLoadHttpAdapter {
  const fixed = config(options);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const pending = new Set<() => void>();
  let closed = false;
  const send: LoadPorts['send'] = (input) => {
    if (closed || fixed.signal?.aborted)
      return Promise.reject(new CandidateLoadTransportError('cancelled'));
    let path: string;
    try {
      path = requestPath(input);
    } catch {
      return Promise.reject(new CandidateLoadTransportError('invalid'));
    }
    return new Promise<LoadReply>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const cancel = () => finish('cancelled');
      const timer = setTimeout(() => finish('unavailable'), DEADLINE_MS);
      pending.add(cancel);
      fixed.signal?.addEventListener('abort', cancel, { once: true });
      function finish(kind: LoadFailure | null, reply?: LoadReply) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        fixed.signal?.removeEventListener('abort', cancel);
        response?.removeAllListeners('data');
        response?.removeAllListeners('end');
        if (kind !== null || reply?.status !== 200) {
          response?.destroy();
          request?.destroy();
        }
        if (kind !== null) reject(new CandidateLoadTransportError(kind));
        else if (reply !== undefined) resolve(reply);
      }
      if (fixed.signal?.aborted || closed) return finish('cancelled');
      void Promise.resolve()
        .then(fixed.accessToken)
        .then((token) => {
          if (settled) return;
          if (
            typeof token !== 'string' ||
            token.length === 0 ||
            Buffer.byteLength(token) > 16384 ||
            /\s/.test(token)
          )
            return finish('denied');
          request = httpRequest(
            `${fixed.apiOrigin}${path}`,
            {
              method: 'GET',
              agent,
              headers: {
                Accept: 'application/json',
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
              if (settled) {
                incoming.destroy();
                return;
              }
              const status = incoming.statusCode ?? 0;
              const contentType = incoming.headers['content-type'] ?? '';
              if (status !== 200)
                return finish(null, {
                  boundary: 'api-http',
                  status,
                  contentType,
                  wireBytes: 0,
                  body: null,
                });
              const encoding = incoming.headers['content-encoding'];
              const length = incoming.headers['content-length'];
              if (
                !/^application\/json(?:\s*;|$)/i.test(contentType) ||
                (encoding !== undefined &&
                  encoding.toLowerCase() !== 'identity') ||
                (length !== undefined &&
                  (!/^\d+$/.test(length) ||
                    !Number.isSafeInteger(Number(length)) ||
                    Number(length) > LOAD_PAGE_BYTES))
              )
                return finish('invalid');
              const decoder = new TextDecoder('utf-8', { fatal: true });
              let wireBytes = 0,
                text = '';
              incoming.on('data', (chunk: Buffer) => {
                if (settled) return;
                wireBytes += chunk.length;
                if (wireBytes > LOAD_PAGE_BYTES) return finish('invalid');
                try {
                  text += decoder.decode(chunk, { stream: true });
                } catch {
                  finish('invalid');
                }
              });
              incoming.on('end', () => {
                if (!incoming.complete) return finish('unavailable');
                try {
                  text += decoder.decode();
                  const body: unknown = JSON.parse(text);
                  finish(null, {
                    boundary: 'api-http',
                    status,
                    contentType,
                    wireBytes,
                    body,
                  });
                } catch {
                  finish('invalid');
                }
              });
            },
          );
          request.on('error', (error) => finish(networkFailure(error)));
          request.end();
        })
        .catch((error: unknown) => finish(sessionFailure(error)));
    });
  };
  return {
    send,
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
      agent.destroy();
    },
    diagnostics: () => ({ activeRequests: pending.size, closed }),
  };
}
