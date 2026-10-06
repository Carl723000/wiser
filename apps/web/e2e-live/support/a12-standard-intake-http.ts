import { createHash } from 'node:crypto';
import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import {
  CompleteUploadSessionOutputSchema,
  CreateIngestionOutputSchema,
  CreateUploadSessionOutputSchema,
  DATA_CAPABILITY_REGISTRY,
  GetIngestionOutputSchema,
  OperationEventPageSchema,
  OperationOutputSchema,
  OperationSchema,
  UploadTargetSchema,
} from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
  type LoadFailure,
} from './a12-candidate-load-driver.ts';

export type A12StandardIntakeCapability =
  | 'data.uploadSession.create'
  | 'data.uploadSession.complete'
  | 'data.ingestion.create'
  | 'data.ingestion.submit'
  | 'data.ingestion.get'
  | 'data.operation.get'
  | 'data.operation.events';
const OUTPUT_SCHEMAS = {
  'data.uploadSession.create': CreateUploadSessionOutputSchema,
  'data.uploadSession.complete': CompleteUploadSessionOutputSchema,
  'data.ingestion.create': CreateIngestionOutputSchema,
  'data.ingestion.submit': OperationOutputSchema,
  'data.ingestion.get': GetIngestionOutputSchema,
  'data.operation.get': OperationSchema,
  'data.operation.events': OperationEventPageSchema,
} as const;
export type A12StandardIntakeBody<C extends A12StandardIntakeCapability> =
  ReturnType<(typeof OUTPUT_SCHEMAS)[C]['parse']>;
export interface A12StandardIntakeHttpOptions {
  readonly apiOrigin: string;
  readonly taskApiPort: number;
  readonly storageOrigin: string;
  readonly taskStoragePort: number;
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly accessToken: () => Promise<string>;
  readonly signal?: AbortSignal;
}
export interface A12StandardIntakeRequest<
  C extends A12StandardIntakeCapability,
> {
  readonly capabilityId: C;
  readonly input: unknown;
  readonly idempotencyKey?: string;
  readonly ifMatch?: string;
}
export interface A12StandardIntakeReply<C extends A12StandardIntakeCapability> {
  readonly capabilityId: C;
  readonly status: number;
  readonly contentType: string;
  readonly wireBytes: number;
  readonly wireSha256: string;
  /** Live in-memory DTO only. Use the explicit projection before persistence. */
  readonly body: A12StandardIntakeBody<C>;
}
export interface A12StandardIntakePutInput {
  readonly target: unknown;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
}
export interface A12StandardIntakePutReply {
  readonly status: number;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly wireBytes: number;
  readonly wireSha256: string;
  readonly etag: string | null;
}
export interface A12StandardIntakeProjection<
  C extends A12StandardIntakeCapability,
> {
  readonly kind: 'redacted-actual-http-projection';
  readonly capabilityId: C;
  readonly status: number;
  readonly wireBytes: number;
  readonly wireSha256: string;
  readonly projectionSha256: string;
  readonly redactedFields: readonly string[];
  readonly body: A12StandardIntakeBody<C>;
}
export interface A12StandardIntakeHttpAdapter {
  readonly send: <C extends A12StandardIntakeCapability>(
    request: A12StandardIntakeRequest<C>,
  ) => Promise<A12StandardIntakeReply<C>>;
  readonly put: (
    input: A12StandardIntakePutInput,
  ) => Promise<A12StandardIntakePutReply>;
  readonly close: () => void;
  readonly diagnostics: () => { activeRequests: number; closed: boolean };
}

const CAPABILITIES: readonly A12StandardIntakeCapability[] = [
  'data.uploadSession.create',
  'data.uploadSession.complete',
  'data.ingestion.create',
  'data.ingestion.submit',
  'data.ingestion.get',
  'data.operation.get',
  'data.operation.events',
];
const PUT_BYTES = 32 * 1024 * 1024;
const PUT_RESPONSE_BYTES = 64 * 1024;
const SNAPSHOT_DEADLINE_MS = 30_000;
const nativeAbortedDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
);
function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (nativeAbortedDescriptor?.get === undefined) return fail('invalid');
  const state: unknown = nativeAbortedDescriptor.get.call(signal);
  return state === true;
}
function listenAbort(
  signal: AbortSignal | undefined,
  cancel: () => void,
  remove = false,
): void {
  if (signal !== undefined) {
    if (remove)
      EventTarget.prototype.removeEventListener.call(signal, 'abort', cancel);
    else
      EventTarget.prototype.addEventListener.call(signal, 'abort', cancel, {
        once: true,
      });
  }
}
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
function fail(kind: LoadFailure): never {
  throw new CandidateLoadTransportError(kind);
}

/** Inspect descriptors before reading any caller-owned field. */
function fields(
  value: unknown,
  allowed?: readonly string[],
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
      (key) => typeof key !== 'string' || (allowed && !allowed.includes(key)),
    )
  )
    return fail('invalid');
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) return fail('invalid');
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return result;
}
function snapshot(value: unknown, depth = 0, budget = { count: 0 }): unknown {
  if (++budget.count > 100_000 || depth > 64) return fail('invalid');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === undefined
  )
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      return fail('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length: unknown = Object.getOwnPropertyDescriptor(
      value,
      'length',
    )?.value;
    if (
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (length as number) > 10_000
    )
      return fail('invalid');
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
      )
    )
      return fail('invalid');
    const result: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        return fail('invalid');
      result.push(snapshot(descriptor.value, depth + 1, budget));
    }
    if (Reflect.ownKeys(descriptors).length !== (length as number) + 1)
      return fail('invalid');
    return result;
  }
  const data = fields(value);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, field] of Object.entries(data))
    Object.defineProperty(result, key, {
      value: snapshot(field, depth + 1, budget),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function origin(value: unknown, port: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    return fail('invalid');
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    Number(parsed.port || 80) !== port ||
    (value !== parsed.origin && value !== parsed.origin + '/')
  )
    return fail('invalid');
  return parsed.origin;
}
function config(
  value: A12StandardIntakeHttpOptions,
): A12StandardIntakeHttpOptions {
  try {
    const data = fields(value, [
      'apiOrigin',
      'taskApiPort',
      'storageOrigin',
      'taskStoragePort',
      'tenantId',
      'projectId',
      'purpose',
      'accessToken',
      'signal',
    ]);
    const apiOrigin = origin(data.apiOrigin, data.taskApiPort);
    const storageOrigin = origin(data.storageOrigin, data.taskStoragePort);
    if (
      !PlatformUuidSchema.safeParse(data.tenantId).success ||
      !PlatformUuidSchema.safeParse(data.projectId).success ||
      !PlatformPurposeSchema.safeParse(data.purpose).success ||
      typeof data.accessToken !== 'function' ||
      (data.signal !== undefined && !(data.signal instanceof AbortSignal))
    )
      return fail('invalid');
    // Confirm the native signal brand without invoking caller-owned properties.
    aborted(data.signal);
    return Object.freeze({
      ...data,
      apiOrigin,
      storageOrigin,
    }) as unknown as A12StandardIntakeHttpOptions;
  } catch {
    return fail('invalid');
  }
}
interface ApiPlan<C extends A12StandardIntakeCapability> {
  capabilityId: C;
  path: string;
  method: string;
  status: number;
  timeout: number;
  headers: Record<string, string>;
  body?: Buffer;
  input: Record<string, unknown>;
}
function apiPlan<C extends A12StandardIntakeCapability>(
  value: A12StandardIntakeRequest<C>,
  fixed: A12StandardIntakeHttpOptions,
): ApiPlan<C> {
  const data = fields(value, [
    'capabilityId',
    'input',
    'idempotencyKey',
    'ifMatch',
  ]);
  if (!CAPABILITIES.includes(data.capabilityId as A12StandardIntakeCapability))
    return fail('invalid');
  const capabilityId = data.capabilityId as C;
  const definition = DATA_CAPABILITY_REGISTRY[capabilityId];
  const input = definition.inputSchema.safeParse(snapshot(data.input));
  if (!input.success) return fail('invalid');
  const body = { ...fields(input.data) };
  const command = definition.kind === 'command';
  const headers: Record<string, string> = {};
  if (command) {
    if (!PlatformUuidSchema.safeParse(data.idempotencyKey).success)
      return fail('invalid');
    headers['Idempotency-Key'] = data.idempotencyKey as string;
  } else if (data.idempotencyKey !== undefined || data.ifMatch !== undefined)
    return fail('invalid');
  if (
    capabilityId === 'data.uploadSession.complete' ||
    capabilityId === 'data.ingestion.submit'
  ) {
    if (
      typeof data.ifMatch !== 'string' ||
      !/^"v[1-9]\d*"$/.test(data.ifMatch) ||
      Number(data.ifMatch.slice(2, -1)) !== body.expectedVersion
    )
      return fail('invalid');
    headers['If-Match'] = data.ifMatch;
  } else if (data.ifMatch !== undefined) return fail('invalid');
  if (
    body.ownerProjectId !== undefined &&
    body.ownerProjectId !== fixed.projectId
  )
    return fail('invalid');
  if (
    capabilityId === 'data.uploadSession.create' &&
    body.preferredMode !== 'PRESIGNED_PUT'
  )
    return fail('invalid');
  let path: string = definition.restMapping.path;
  const query = new URLSearchParams();
  for (const [key, field] of Object.entries(body)) {
    if (path.includes(`:${key}`)) {
      if (typeof field !== 'string') return fail('invalid');
      path = path.replace(`:${key}`, encodeURIComponent(field));
      delete body[key];
    } else if (!command && field !== undefined) {
      if (typeof field !== 'string' && typeof field !== 'number')
        return fail('invalid');
      query.set(key, String(field));
    }
  }
  if (/:[a-zA-Z]/.test(path)) return fail('invalid');
  if (query.size) path += `?${query}`;
  const bytes = command ? Buffer.from(JSON.stringify(body)) : undefined;
  if (bytes && bytes.length > LOAD_PAGE_BYTES) return fail('invalid');
  return {
    capabilityId,
    path,
    method: definition.restMapping.method,
    status: definition.restMapping.successStatus,
    // REST supplies a finite snapshot. The capability's 900s long-stream allowance is not a reason to wait 900s.
    timeout:
      capabilityId === 'data.operation.events'
        ? SNAPSHOT_DEADLINE_MS
        : definition.timeout,
    headers,
    ...(bytes ? { body: bytes } : {}),
    input: input.data as Record<string, unknown>,
  };
}
function failureStatus(status: number): LoadFailure {
  if (status === 401 || status === 403) return 'denied';
  if (status === 404 || status === 409 || status === 410) return 'stale';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'invalid';
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
function tokenFailure(error: unknown): LoadFailure {
  try {
    const kind: unknown =
      error instanceof CandidateLoadTransportError
        ? Object.getOwnPropertyDescriptor(error, 'kind')?.value
        : undefined;
    return kind === 'stale' || kind === 'denied' || kind === 'cancelled'
      ? kind
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
function header(response: IncomingMessage, name: string): string | undefined {
  if (
    response.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === name,
    ).length > 1
  )
    return fail('invalid');
  const value = response.headers[name];
  if (value !== undefined && typeof value !== 'string') return fail('invalid');
  return value;
}
function parseSnapshot(
  text: string,
  response: IncomingMessage,
  operationId: unknown,
): unknown {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r') || !normalized.endsWith('\n\n'))
    return fail('invalid');
  const items: unknown[] = [];
  const ids = new Set<string>();
  let lastSequence = 0;
  for (const frame of normalized.split('\n\n')) {
    if (!frame) continue;
    const fields = new Map<string, string>();
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
      const match = /^(id|event|data): ?(.*)$/.exec(line);
      const key = match?.[1],
        value = match?.[2];
      if (key === undefined || value === undefined || fields.has(key))
        return fail('invalid');
      fields.set(key, value);
    }
    if (!fields.size) continue;
    if (fields.size !== 3) return fail('invalid');
    const event: unknown = JSON.parse(fields.get('data')!);
    const page = OperationEventPageSchema.safeParse({ items: [event] });
    if (!page.success) return fail('invalid');
    const item = page.data.items[0];
    if (item === undefined) return fail('invalid');
    if (
      item.eventId !== fields.get('id') ||
      item.eventType !== fields.get('event') ||
      item.operationId !== operationId ||
      ids.has(item.eventId) ||
      item.sequence <= lastSequence ||
      items.length >= 10_000
    )
      return fail('invalid');
    ids.add(item.eventId);
    lastSequence = item.sequence;
    items.push(item);
  }
  const nextCursor = header(response, 'x-next-cursor');
  return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}
function scopeMatches(
  body: Record<string, unknown>,
  plan: ApiPlan<A12StandardIntakeCapability>,
  fixed: A12StandardIntakeHttpOptions,
): void {
  const scoped = (
    plan.capabilityId.startsWith('data.uploadSession.')
      ? body.uploadSession
      : plan.capabilityId === 'data.ingestion.get'
        ? body.ingestion
        : plan.capabilityId === 'data.ingestion.create' ||
            plan.capabilityId === 'data.ingestion.submit'
          ? body.operation
          : body
  ) as Record<string, unknown>;
  if (
    plan.capabilityId !== 'data.operation.events' &&
    (scoped.tenantId !== fixed.tenantId || scoped.projectId !== fixed.projectId)
  )
    return fail('invalid');
  const idKey =
    plan.capabilityId === 'data.uploadSession.complete'
      ? 'uploadSessionId'
      : plan.capabilityId === 'data.ingestion.get'
        ? 'ingestionId'
        : plan.capabilityId === 'data.operation.get'
          ? 'operationId'
          : undefined;
  if (idKey && scoped[idKey] !== plan.input[idKey]) return fail('invalid');
  if (
    plan.capabilityId === 'data.ingestion.get' &&
    body.candidateReference !== null
  ) {
    const reference = body.candidateReference as Record<string, unknown>;
    if (
      reference.ingestionId !== scoped.ingestionId ||
      reference.ingestionId !== plan.input.ingestionId
    )
      return fail('invalid');
  }
  if (
    plan.capabilityId === 'data.uploadSession.create' &&
    (body.uploadTargets as { method: string }[]).some(
      (target) => target.method !== 'PRESIGNED_PUT',
    )
  )
    return fail('invalid');
}
interface WireTask<T> {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  status: number;
  timeout: number;
  limit: number;
  mode: 'json' | 'sse' | 'bytes';
  auth: boolean;
  decode: (bytes: Buffer, response: IncomingMessage) => T;
}

/** Mechanical, task-owned HTTP only. A successful reply does not certify scanning or admission. */
export function createA12StandardIntakeHttpAdapter(
  options: A12StandardIntakeHttpOptions,
): A12StandardIntakeHttpAdapter {
  const fixed = config(options);
  const agent = new Agent({ keepAlive: true, maxSockets: 8 });
  const pending = new Set<() => void>();
  let closed = false;
  function execute<T>(task: WireTask<T>): Promise<T> {
    if (closed || aborted(fixed.signal))
      return Promise.reject(new CandidateLoadTransportError('cancelled'));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const cancel = () => finish('cancelled');
      const timer = setTimeout(() => finish('unavailable'), task.timeout);
      pending.add(cancel);
      listenAbort(fixed.signal, cancel);
      function finish(kind: LoadFailure | null, result?: T) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(cancel);
        listenAbort(fixed.signal, cancel, true);
        response?.removeAllListeners('data');
        response?.removeAllListeners('end');
        if (kind !== null) {
          response?.destroy();
          request?.destroy();
          reject(new CandidateLoadTransportError(kind));
        } else resolve(result as T);
      }
      function start(token?: string) {
        if (settled) return;
        if (closed || aborted(fixed.signal)) return finish('cancelled');
        if (
          task.auth &&
          (typeof token !== 'string' ||
            !token ||
            Buffer.byteLength(token) > 16384 ||
            /\s/.test(token))
        )
          return finish('denied');
        try {
          const headers = {
            ...task.headers,
            ...(task.auth
              ? {
                  Authorization: `Bearer ${token}`,
                  'X-WISER-Tenant-ID': fixed.tenantId,
                  'X-WISER-Project-ID': fixed.projectId,
                  'X-WISER-Purpose': fixed.purpose,
                }
              : {}),
          };
          request = httpRequest(
            task.url,
            { method: task.method, headers, agent },
            (incoming) => {
              response = incoming;
              incoming.on('error', () => finish('unavailable'));
              incoming.on('aborted', () => finish('unavailable'));
              incoming.on('close', () => {
                if (!incoming.complete) finish('unavailable');
              });
              if (settled) {
                incoming.destroy();
                return;
              }
              const status = incoming.statusCode ?? 0;
              if (status !== task.status) return finish(failureStatus(status));
              try {
                const contentType = header(incoming, 'content-type') ?? '';
                const encoding = header(incoming, 'content-encoding');
                const length = header(incoming, 'content-length');
                if (
                  (task.mode === 'json' &&
                    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                      contentType,
                    )) ||
                  (task.mode === 'sse' &&
                    !/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/i.test(
                      contentType,
                    )) ||
                  (encoding !== undefined &&
                    encoding.toLowerCase() !== 'identity') ||
                  (length !== undefined &&
                    (!/^\d+$/.test(length) ||
                      !Number.isSafeInteger(Number(length)) ||
                      Number(length) > task.limit))
                )
                  return finish('invalid');
              } catch {
                return finish('invalid');
              }
              let wireBytes = 0;
              const chunks: Buffer[] = [];
              incoming.on('data', (chunk: Buffer) => {
                if (settled) return;
                wireBytes += chunk.length;
                if (wireBytes > task.limit) return finish('invalid');
                chunks.push(chunk);
              });
              incoming.on('end', () => {
                if (settled) return;
                if (!incoming.complete) return finish('unavailable');
                try {
                  finish(
                    null,
                    task.decode(Buffer.concat(chunks, wireBytes), incoming),
                  );
                } catch {
                  finish('invalid');
                }
              });
            },
          );
          request.on('error', (error: unknown) =>
            finish(networkFailure(error)),
          );
          request.end(task.body);
        } catch {
          finish('invalid');
        }
      }
      if (closed || aborted(fixed.signal)) return finish('cancelled');
      if (task.auth)
        void Promise.resolve()
          .then(fixed.accessToken)
          .then((token) => start(token))
          .catch((error: unknown) => finish(tokenFailure(error)));
      else start();
    });
  }
  return {
    send<C extends A12StandardIntakeCapability>(
      input: A12StandardIntakeRequest<C>,
    ): Promise<A12StandardIntakeReply<C>> {
      if (closed || aborted(fixed.signal))
        return Promise.reject(new CandidateLoadTransportError('cancelled'));
      let plan: ApiPlan<C>;
      try {
        plan = apiPlan(input, fixed);
      } catch {
        return Promise.reject(new CandidateLoadTransportError('invalid'));
      }
      const sse = plan.capabilityId === 'data.operation.events';
      return execute({
        url: `${fixed.apiOrigin}${plan.path}`,
        method: plan.method,
        status: plan.status,
        timeout: plan.timeout,
        limit: LOAD_PAGE_BYTES,
        mode: sse ? 'sse' : 'json',
        auth: true,
        headers: {
          Accept: sse ? 'text/event-stream' : 'application/json',
          'Accept-Encoding': 'identity',
          ...plan.headers,
          ...(plan.body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(plan.body.length),
              }
            : {}),
        },
        ...(plan.body ? { body: plan.body } : {}),
        decode(bytes, response) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const body: unknown = sse
            ? parseSnapshot(text, response, plan.input.operationId)
            : JSON.parse(text);
          const parsed = OUTPUT_SCHEMAS[plan.capabilityId].safeParse(body);
          if (!parsed.success) return fail('invalid');
          scopeMatches(parsed.data as Record<string, unknown>, plan, fixed);
          return freeze({
            capabilityId: plan.capabilityId,
            status: plan.status,
            contentType: header(response, 'content-type') ?? '',
            wireBytes: bytes.length,
            wireSha256: sha(bytes),
            body: parsed.data as A12StandardIntakeBody<C>,
          });
        },
      });
    },
    put(input: A12StandardIntakePutInput): Promise<A12StandardIntakePutReply> {
      if (closed || aborted(fixed.signal))
        return Promise.reject(new CandidateLoadTransportError('cancelled'));
      let url: string,
        headers: Record<string, string>,
        bytes: Buffer,
        digest: string;
      try {
        const data = fields(input, ['target', 'bytes', 'sizeBytes', 'sha256']);
        if (
          !(data.bytes instanceof Uint8Array) ||
          ![Uint8Array.prototype, Buffer.prototype].includes(
            Object.getPrototypeOf(data.bytes) as Uint8Array,
          ) ||
          ['byteLength', 'buffer', 'byteOffset', 'length', 'constructor'].some(
            (key) => Object.hasOwn(data.bytes as object, key),
          ) ||
          Object.getOwnPropertySymbols(data.bytes).length ||
          !Number.isSafeInteger(data.sizeBytes) ||
          (data.sizeBytes as number) < 1 ||
          (data.sizeBytes as number) > PUT_BYTES ||
          data.bytes.byteLength !== data.sizeBytes ||
          data.bytes.buffer instanceof SharedArrayBuffer ||
          typeof data.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(data.sha256)
        )
          return fail('invalid');
        // Copy synchronously, before token/HTTP scheduling or any caller mutation.
        bytes = Buffer.from(data.bytes);
        digest = sha(bytes);
        if (digest !== data.sha256) return fail('invalid');
        const target = UploadTargetSchema.safeParse(snapshot(data.target));
        if (!target.success || target.data.method !== 'PRESIGNED_PUT')
          return fail('invalid');
        const parsed = new URL(target.data.uploadUrl!);
        if (
          parsed.origin !== fixed.storageOrigin ||
          parsed.protocol !== 'http:' ||
          parsed.hostname !== '127.0.0.1' ||
          Number(parsed.port || 80) !== fixed.taskStoragePort ||
          parsed.username ||
          parsed.password ||
          parsed.hash
        )
          return fail('invalid');
        url = parsed.href;
        headers = {};
        for (const [key, value] of Object.entries(target.data.headers)) {
          const name = key.toLowerCase();
          if (
            !['content-length', 'content-type', 'x-amz-meta-sha256'].includes(
              name,
            ) ||
            Object.hasOwn(headers, name) ||
            /[\r\n]/.test(value)
          )
            return fail('invalid');
          headers[name] = value;
        }
        if (
          headers['content-length'] !== String(bytes.length) ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
            headers['content-type'] ?? '',
          ) ||
          (headers['x-amz-meta-sha256'] !== undefined &&
            headers['x-amz-meta-sha256'] !== digest)
        )
          return fail('invalid');
      } catch {
        return Promise.reject(new CandidateLoadTransportError('invalid'));
      }
      return execute({
        url,
        method: 'PUT',
        headers,
        body: bytes,
        status: 200,
        timeout: SNAPSHOT_DEADLINE_MS,
        limit: PUT_RESPONSE_BYTES,
        mode: 'bytes',
        auth: false,
        decode(wire, response) {
          const etag = header(response, 'etag') ?? null;
          if (
            etag !== null &&
            (!etag || etag.length > 1024 || /[\r\n]/.test(etag))
          )
            return fail('invalid');
          return Object.freeze({
            status: 200,
            requestBytes: bytes.length,
            requestSha256: digest,
            wireBytes: wire.length,
            wireSha256: sha(wire),
            etag,
          });
        },
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel();
      agent.destroy();
    },
    diagnostics: () => ({ activeRequests: pending.size, closed }),
  };
}

export function redactA12StandardIntakeReply<
  C extends A12StandardIntakeCapability,
>(reply: A12StandardIntakeReply<C>): A12StandardIntakeProjection<C> {
  try {
    const data = fields(reply, [
      'capabilityId',
      'status',
      'contentType',
      'wireBytes',
      'wireSha256',
      'body',
    ]);
    if (
      !CAPABILITIES.includes(
        data.capabilityId as A12StandardIntakeCapability,
      ) ||
      !Number.isSafeInteger(data.wireBytes) ||
      (data.wireBytes as number) < 0 ||
      typeof data.wireSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(data.wireSha256)
    )
      return fail('invalid');
    const capabilityId = data.capabilityId as C;
    const definition = DATA_CAPABILITY_REGISTRY[capabilityId];
    if (
      typeof data.status !== 'number' ||
      data.status !== definition.restMapping.successStatus
    )
      return fail('invalid');
    const parsed = OUTPUT_SCHEMAS[capabilityId].safeParse(snapshot(data.body));
    if (!parsed.success) return fail('invalid');
    const body = snapshot(parsed.data) as Record<string, unknown>;
    const redactedFields: string[] = [];
    if (capabilityId === 'data.uploadSession.create') {
      const targets = body.uploadTargets as Record<string, unknown>[];
      targets.forEach((target, index) => {
        if (target.method !== 'PRESIGNED_PUT') return fail('invalid');
        target.uploadUrl = 'https://redacted.invalid/';
        target.headers = {};
        redactedFields.push(
          `body.uploadTargets[${index}].uploadUrl`,
          `body.uploadTargets[${index}].headers`,
        );
      });
    }
    const operation =
      capabilityId === 'data.operation.get'
        ? body
        : capabilityId === 'data.ingestion.create' ||
            capabilityId === 'data.ingestion.submit'
          ? (body.operation as Record<string, unknown>)
          : undefined;
    if (operation?.error !== undefined) {
      (operation.error as Record<string, unknown>).message = 'redacted';
      redactedFields.push(
        capabilityId === 'data.operation.get'
          ? 'body.error.message'
          : 'body.operation.error.message',
      );
    }
    if (capabilityId === 'data.operation.events')
      (body.items as Record<string, unknown>[]).forEach((event, index) => {
        if (event.message !== undefined) {
          delete event.message;
          redactedFields.push(`body.items[${index}].message`);
        }
      });
    if (
      capabilityId === 'data.ingestion.get' &&
      body.qualityIssues !== undefined
    )
      (body.qualityIssues as Record<string, unknown>[]).forEach(
        (issue, index) => {
          issue.message = 'redacted';
          redactedFields.push(`body.qualityIssues[${index}].message`);
          if (issue.fieldPath !== undefined) {
            delete issue.fieldPath;
            redactedFields.push(`body.qualityIssues[${index}].fieldPath`);
          }
        },
      );
    const projected = OUTPUT_SCHEMAS[capabilityId].safeParse(body);
    if (!projected.success) return fail('invalid');
    // Pure projection, not an admission certificate. The live collector owns provenance/opaque handles.
    return freeze({
      kind: 'redacted-actual-http-projection' as const,
      capabilityId,
      status: data.status,
      wireBytes: data.wireBytes as number,
      wireSha256: data.wireSha256,
      projectionSha256: sha(JSON.stringify(projected.data)),
      redactedFields,
      body: projected.data as A12StandardIntakeBody<C>,
    });
  } catch {
    return fail('invalid');
  }
}
