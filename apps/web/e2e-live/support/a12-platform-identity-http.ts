import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  CandidateLoadTransportError,
  type LoadFailure,
} from './a12-candidate-load-driver.ts';
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

const MAX_BYTES = 32 * 1024;
const DEADLINE_MS = 30_000;
function captureNative(prototype: object, name: string, kind: 'get' | 'value') {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  const method: unknown = descriptor
    ? Reflect.get(descriptor, kind)
    : undefined;
  return typeof method === 'function' ? method : null;
}
const nativeAborted = captureNative(AbortSignal.prototype, 'aborted', 'get');
const nativeAdd = captureNative(
  EventTarget.prototype,
  'addEventListener',
  'value',
);
const nativeRemove = captureNative(
  EventTarget.prototype,
  'removeEventListener',
  'value',
);
function fail(kind: LoadFailure): never {
  throw new CandidateLoadTransportError(kind);
}
function dataFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(
      Object.getPrototypeOf(value) as object | null,
    )
  )
    return fail('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !keys.includes(key),
    ) ||
    Object.values(descriptors).some((entry) => !Object.hasOwn(entry, 'value'))
  )
    return fail('invalid');
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, entry]) => [key, entry.value]),
  );
}
function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (typeof nativeAborted !== 'function') return fail('invalid');
  return Reflect.apply(nativeAborted, signal, []) === true;
}
function configuration(
  value: A12PlatformIdentityHttpOptions,
): A12PlatformIdentityHttpOptions {
  try {
    const raw = dataFields(value, ['apiOrigin', 'taskApiPort', 'signal']);
    if (
      typeof raw.apiOrigin !== 'string' ||
      typeof raw.taskApiPort !== 'number'
    )
      return fail('invalid');
    const origin = new URL(raw.apiOrigin);
    if (
      origin.protocol !== 'http:' ||
      origin.hostname !== '127.0.0.1' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      (raw.apiOrigin !== origin.origin &&
        raw.apiOrigin !== origin.origin + '/') ||
      !Number.isInteger(raw.taskApiPort) ||
      raw.taskApiPort < 1 ||
      raw.taskApiPort > 65535 ||
      Number(origin.port || 80) !== raw.taskApiPort ||
      (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) ||
      typeof nativeAdd !== 'function' ||
      typeof nativeRemove !== 'function'
    )
      return fail('invalid');
    const signal = raw.signal;
    aborted(signal);
    return Object.freeze({
      apiOrigin: origin.origin,
      taskApiPort: raw.taskApiPort,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    return fail('invalid');
  }
}
function requestInput(value: CandidateLoadMeInput): CandidateLoadMeInput {
  try {
    const raw = dataFields(value, [
      'accessToken',
      'tenantId',
      'projectId',
      'purpose',
    ]);
    if (
      typeof raw.accessToken !== 'string' ||
      raw.accessToken.length === 0 ||
      Buffer.byteLength(raw.accessToken) > 16_384 ||
      /\s/.test(raw.accessToken)
    )
      return fail('invalid');
    return Object.freeze({
      accessToken: raw.accessToken,
      tenantId: PlatformUuidSchema.parse(raw.tenantId),
      projectId: PlatformUuidSchema.parse(raw.projectId),
      purpose: PlatformPurposeSchema.parse(raw.purpose),
    });
  } catch {
    return fail('invalid');
  }
}

/** Wire consumer only. Existing Auth verifies the returned identity, not this adapter. */
export function createA12PlatformIdentityHttp(
  options: A12PlatformIdentityHttpOptions,
): A12PlatformIdentityHttp {
  const fixed = configuration(options);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const pending = new Set<() => void>();
  let closed = false;
  const readMe: A12PlatformIdentityHttp['readMe'] = (input) => {
    if (closed || aborted(fixed.signal))
      return Promise.reject(new CandidateLoadTransportError('cancelled'));
    let selected: CandidateLoadMeInput;
    try {
      selected = requestInput(input);
    } catch {
      return Promise.reject(new CandidateLoadTransportError('invalid'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const timer = setTimeout(() => finish('unavailable'), DEADLINE_MS);
      const cancel = () => finish('cancelled');
      function finish(
        kind: LoadFailure | null,
        reply?: { status: number; body: unknown },
      ) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        if (fixed.signal)
          Reflect.apply(nativeRemove!, fixed.signal, ['abort', cancel]);
        response?.removeAllListeners('data');
        response?.removeAllListeners('end');
        if (kind !== null || reply?.status !== 200) {
          response?.destroy();
          request?.destroy();
        }
        if (kind !== null) reject(new CandidateLoadTransportError(kind));
        else if (reply !== undefined) resolve(Object.freeze(reply));
      }
      pending.add(cancel);
      if (fixed.signal)
        Reflect.apply(nativeAdd!, fixed.signal, [
          'abort',
          cancel,
          { once: true },
        ]);
      if (closed || aborted(fixed.signal)) return finish('cancelled');
      try {
        request = httpRequest(
          `${fixed.apiOrigin}/api/platform/v1/me`,
          {
            method: 'GET',
            agent,
            headers: {
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
              Authorization: `Bearer ${selected.accessToken}`,
              'X-Wiser-Tenant-Id': selected.tenantId,
              'X-Wiser-Project-Id': selected.projectId,
              'X-Wiser-Purpose': selected.purpose,
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
            if (status < 100 || status > 599) return finish('unavailable');
            if (status !== 200) return finish(null, { status, body: null });
            const type = incoming.headers['content-type'] ?? '';
            const encoding = incoming.headers['content-encoding'];
            const length = incoming.headers['content-length'];
            if (
              !/^application\/json(?:\s*;|$)/i.test(type) ||
              (encoding !== undefined &&
                encoding.toLowerCase() !== 'identity') ||
              (length !== undefined &&
                (!/^\d+$/.test(length) ||
                  !Number.isSafeInteger(Number(length)) ||
                  Number(length) > MAX_BYTES))
            )
              return finish('invalid');
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let bytes = 0,
              text = '';
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return;
              bytes += chunk.length;
              if (bytes > MAX_BYTES) return finish('invalid');
              try {
                text += decoder.decode(chunk, { stream: true });
              } catch {
                finish('invalid');
              }
            });
            incoming.on('end', () => {
              if (settled) return;
              if (!incoming.complete) return finish('unavailable');
              try {
                text += decoder.decode();
                const body: unknown = JSON.parse(text);
                finish(null, { status, body });
              } catch {
                finish('invalid');
              }
            });
          },
        );
        request.on('error', () => finish('unavailable'));
        request.end();
      } catch {
        finish('unavailable');
      }
    });
  };
  return Object.freeze({
    readMe,
    close: () => {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
      agent.destroy();
    },
    diagnostics: () => ({ activeRequests: pending.size, closed }),
  });
}
