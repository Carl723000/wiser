import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  CreateIngestionInputSchema,
  CreateIngestionInputV1Schema,
  SourceRegistrationSchema,
  UploadObjectRequestSchema,
} from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  authenticateCandidateLoad,
  CandidateLoadAuthError,
  type CandidateLoadAuthCondition,
  type CandidateLoadAuthGuard,
} from './a12-candidate-load-auth.ts';
import { CandidateLoadTransportError } from './a12-candidate-load-driver.ts';
import { createA12PlatformIdentityHttp } from './a12-platform-identity-http.ts';
import { createA12StandardIntakeHttpAdapter } from './a12-standard-intake-http.ts';
import { createCandidateInventoryCollector } from './a12-candidate-inventory-collector.ts';
import { createCandidateLoadHttpAdapter } from './a12-candidate-load-http.ts';
import { createCandidateOriginalHttpAdapter } from './a12-candidate-original-http.ts';
import type {
  A12FreshIntakeOptions,
  A12FreshPreparedObject,
} from './a12-standard-intake-collector.ts';

type IngestionInput = ReturnType<typeof CreateIngestionInputSchema.parse>;
type SourceMetadata = Omit<
  NonNullable<IngestionInput['sourceRegistration']>,
  'manifestAssetId' | 'manifestSha256'
>;

/** Explicit private inputs from the selected existing runtime; values are not proof. */
export interface ActualCollectorConfiguration {
  readonly apiOrigin: string;
  readonly taskApiPort: number;
  readonly storageOrigin: string;
  readonly taskStoragePort: number;
  readonly authOrigin: string;
  readonly taskAuthPort: number;
  readonly publishableKey: string;
  readonly credentials: { readonly email: string; readonly password: string };
  readonly dataset: A12FreshIntakeOptions['dataset'];
  readonly scope: A12FreshIntakeOptions['scope'];
  readonly prepared: readonly A12FreshPreparedObject[];
  readonly idempotencyKeys: A12FreshIntakeOptions['idempotencyKeys'];
  readonly ingestion: Pick<
    IngestionInput,
    'intendedUses' | 'requestedSecurityLevel'
  > & {
    /** Zero-based uploaded-object ordinal; generated manifest ID is never an input. */
    readonly sourceRegistration?: SourceMetadata & {
      readonly manifestPreparedOrdinal: number;
    };
  };
  readonly maximumStatusReads: number;
  readonly maximumEventPages: number;
  /** Explicit host allocation for known prepared-byte copies; no default or resource proof. */
  readonly preparedMemoryBudgetBytes: number;
}

/** Caller must close after collector.collect(), including construction/collection failure. */
export interface ActualCollectorConstruction {
  readonly options: A12FreshIntakeOptions;
  readonly close: () => void;
}

function invalid(): never {
  // Error text, credentials, URLs and server DTOs are never diagnostics.
  throw new CandidateLoadTransportError('invalid');
}
function dataFields(
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
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)))
      invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return result;
}
function snapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 100_000 || depth > 32) invalid();
  if (
    value === null ||
    ['string', 'boolean', 'undefined'].includes(typeof value)
  )
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'))
      invalid();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      )
        invalid();
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[index];
      if (!descriptor) invalid();
      result.push(snapshot(descriptor.value, depth + 1, budget));
    }
    return Object.freeze(result);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(dataFields(value)))
    Object.defineProperty(result, key, {
      value: snapshot(item, depth + 1, budget),
      enumerable: true,
    });
  return Object.freeze(result);
}
function loopback(value: unknown, port: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65_535
  )
    invalid();
  const url = new URL(value);
  if (
    url.origin !== `http://127.0.0.1:${port as number}` ||
    (value !== url.origin && value !== `${url.origin}/`)
  )
    invalid();
  return url.origin;
}
const bytePrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteDescriptors = Object.getOwnPropertyDescriptors(bytePrototype);
function byteView(value: unknown): {
  backing: ArrayBuffer;
  offset: number;
  length: number;
} {
  if (!(value instanceof Uint8Array)) invalid();
  const length: unknown = byteDescriptors.byteLength?.get?.call(value);
  const offset: unknown = byteDescriptors.byteOffset?.get?.call(value);
  const backing: unknown = byteDescriptors.buffer?.get?.call(value);
  if (
    typeof length !== 'number' ||
    length < 1 ||
    length > 32 * 1024 * 1024 ||
    typeof offset !== 'number' ||
    !(backing instanceof ArrayBuffer)
  )
    invalid();
  // SharedArrayBuffer is deliberately rejected: hashing cannot exclude another writer.
  return { backing, offset, length };
}
function copyBytes(value: unknown): Buffer {
  const { backing, offset, length } = byteView(value);
  return Buffer.from(new Uint8Array(backing, offset, length));
}
const selectionSchema = CreateIngestionInputV1Schema.omit({
  assetIds: true,
  ownerProjectId: true,
});
const sourceMetadataSchema = SourceRegistrationSchema.omit({
  manifestAssetId: true,
  manifestSha256: true,
});
const nativeAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const nativeAdd = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'addEventListener',
)?.value as EventTarget['addEventListener'];
const nativeRemove = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  'removeEventListener',
)?.value as EventTarget['removeEventListener'];
const nativeAbort = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  'abort',
)?.value as AbortController['abort'];
const nativeFill = Object.getOwnPropertyDescriptor(bytePrototype, 'fill')
  ?.value as Uint8Array['fill'];
function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (typeof nativeAborted !== 'function') invalid();
  return Reflect.apply(nativeAborted, signal, []) === true;
}
function safely(release: () => void): void {
  try {
    release();
  } catch {
    /* cleanup must neither replace the first cause nor expose text */
  }
}
type TransportFailure = ConstructorParameters<
  typeof CandidateLoadTransportError
>[0];
function boundedFailure(
  error: unknown,
  configurationAdmitted: boolean,
): TransportFailure {
  try {
    if (error instanceof CandidateLoadAuthError) {
      const kind: unknown = Object.getOwnPropertyDescriptor(
        error,
        'kind',
      )?.value;
      if (kind === 'authentication' || kind === 'denied') return 'denied';
      if (kind === 'changed') return 'stale';
      if (kind === 'closed') return 'cancelled';
      if (kind === 'unavailable') return 'unavailable';
      return 'invalid'; // configuration, invalid and unknown classifications
    }
    if (error instanceof CandidateLoadTransportError) {
      const kind: unknown = Object.getOwnPropertyDescriptor(
        error,
        'kind',
      )?.value;
      if (
        kind === 'denied' ||
        kind === 'stale' ||
        kind === 'cancelled' ||
        kind === 'invalid' ||
        kind === 'unavailable' ||
        kind === 'drift' ||
        kind === 'instrumentation'
      )
        return kind;
      return 'invalid';
    }
  } catch {
    return 'invalid';
  }
  return configurationAdmitted ? 'unavailable' : 'invalid';
}

/**
 * Construct concrete existing HTTP ports, sign in and verify current identity.
 * Calling this performs login/GET /me. Import/typechecking performs no I/O.
 * It does not launch services, inspect environment, issue verified, or infer a profile.
 */
export async function constructActualCollectorOptions(
  rawConfiguration: ActualCollectorConfiguration,
  signal?: AbortSignal,
): Promise<ActualCollectorConstruction> {
  let auth: CandidateLoadAuthGuard | null = null;
  let condition: CandidateLoadAuthCondition | null = null;
  let closed = false;
  let configurationAdmitted = false;
  let listenerAttached = false;
  const cancellation = new AbortController();
  const releases: Array<() => void> = [];
  const prepared: A12FreshPreparedObject[] = [];
  const ownedBytes: Buffer[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    if (listenerAttached && signal) {
      listenerAttached = false;
      safely(() => Reflect.apply(nativeRemove, signal, ['abort', close]));
    }
    safely(() => Reflect.apply(nativeAbort, cancellation, []));
    condition = null;
    const ownedAuth = auth;
    auth = null;
    if (ownedAuth) safely(ownedAuth.close);
    for (const release of releases.splice(0).reverse()) safely(release);
    for (const bytes of ownedBytes.splice(0))
      safely(() => Reflect.apply(nativeFill, bytes, [0]));
    prepared.splice(0);
  };
  try {
    if (signal !== undefined && !(signal instanceof AbortSignal)) invalid();
    if (
      typeof nativeAdd !== 'function' ||
      typeof nativeRemove !== 'function' ||
      typeof nativeAbort !== 'function' ||
      typeof nativeFill !== 'function'
    )
      invalid();
    if (aborted(signal)) throw new CandidateLoadTransportError('cancelled');
    const raw = dataFields(rawConfiguration, [
      'apiOrigin',
      'taskApiPort',
      'storageOrigin',
      'taskStoragePort',
      'authOrigin',
      'taskAuthPort',
      'publishableKey',
      'credentials',
      'dataset',
      'scope',
      'prepared',
      'idempotencyKeys',
      'ingestion',
      'maximumStatusReads',
      'maximumEventPages',
      'preparedMemoryBudgetBytes',
    ]);
    const apiOrigin = loopback(raw.apiOrigin, raw.taskApiPort);
    const storageOrigin = loopback(raw.storageOrigin, raw.taskStoragePort);
    const authOrigin = loopback(raw.authOrigin, raw.taskAuthPort);
    const scopeFields = dataFields(raw.scope, [
      'tenantId',
      'projectId',
      'purpose',
    ]);
    const scope = Object.freeze({
      tenantId: PlatformUuidSchema.parse(scopeFields.tenantId),
      projectId: PlatformUuidSchema.parse(scopeFields.projectId),
      purpose: PlatformPurposeSchema.parse(scopeFields.purpose),
    });
    if (
      !['AUTHENTICATED-REAL', 'SYNTHETIC-S10'].includes(raw.dataset as string)
    )
      invalid();
    const dataset = raw.dataset as A12FreshIntakeOptions['dataset'];
    const keyFields = dataFields(raw.idempotencyKeys, [
      'createUpload',
      'completeUpload',
      'createIngestion',
      'submitIngestion',
    ]);
    const idempotencyKeys = Object.freeze({
      createUpload: PlatformUuidSchema.parse(keyFields.createUpload),
      completeUpload: PlatformUuidSchema.parse(keyFields.completeUpload),
      createIngestion: PlatformUuidSchema.parse(keyFields.createIngestion),
      submitIngestion: PlatformUuidSchema.parse(keyFields.submitIngestion),
    });
    if (new Set(Object.values(idempotencyKeys)).size !== 4) invalid();
    if (
      !Array.isArray(raw.prepared) ||
      Object.getPrototypeOf(raw.prepared) !== Array.prototype ||
      raw.prepared.length < 1 ||
      raw.prepared.length > 1_000
    )
      invalid();
    const entries = Object.getOwnPropertyDescriptors(raw.prepared);
    if (Reflect.ownKeys(entries).some((key) => typeof key !== 'string'))
      invalid();
    for (const [key, descriptor] of Object.entries(entries)) {
      if (
        !Object.hasOwn(descriptor, 'value') ||
        (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))
      )
        invalid();
    }
    // Preflight native byte lengths before allocating any host copy or performing login.
    // Caller bytes + this host copy + the current collector copy + one serial PUT copy.
    let totalPreparedBytes = 0;
    let largestPreparedBytes = 0;
    for (let index = 0; index < raw.prepared.length; index++) {
      const descriptor = entries[index];
      if (!descriptor) invalid();
      const item = dataFields(descriptor.value, [
        'object',
        'bytes',
        'sha256',
        'sizeBytes',
      ]);
      const { length } = byteView(item.bytes);
      totalPreparedBytes += length;
      largestPreparedBytes = Math.max(largestPreparedBytes, length);
    }
    const knownPreparedCopiesBytes =
      3 * totalPreparedBytes + largestPreparedBytes;
    if (
      !Number.isSafeInteger(raw.preparedMemoryBudgetBytes) ||
      (raw.preparedMemoryBudgetBytes as number) < 1 ||
      knownPreparedCopiesBytes > (raw.preparedMemoryBudgetBytes as number)
    )
      invalid();
    // This allocation declaration neither admits real resources nor budgets other heap/DTOs.
    for (let index = 0; index < raw.prepared.length; index++) {
      const descriptor = entries[index];
      if (!descriptor) invalid();
      const item = dataFields(descriptor.value, [
        'object',
        'bytes',
        'sha256',
        'sizeBytes',
      ]);
      const object = UploadObjectRequestSchema.parse(snapshot(item.object));
      const bytes = copyBytes(item.bytes);
      ownedBytes.push(bytes); // register before hashing/schema consistency can fail
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      prepared.push(
        Object.freeze({
          object: Object.freeze(object),
          bytes,
          sha256,
          sizeBytes: bytes.length,
        }),
      );
      if (
        item.sha256 !== sha256 ||
        object.sha256 !== sha256 ||
        item.sizeBytes !== bytes.length ||
        object.sizeBytes !== bytes.length
      )
        invalid();
    }
    const ingestionFields = dataFields(raw.ingestion, [
      'intendedUses',
      'requestedSecurityLevel',
      'sourceRegistration',
    ]);
    const selection = selectionSchema.parse(
      snapshot({
        intendedUses: ingestionFields.intendedUses,
        requestedSecurityLevel: ingestionFields.requestedSecurityLevel,
      }),
    );
    let source:
      { metadata: SourceMetadata; ordinal: number; sha256: string } | undefined;
    if (ingestionFields.sourceRegistration !== undefined) {
      const sourceFields = dataFields(ingestionFields.sourceRegistration);
      const ordinal = sourceFields.manifestPreparedOrdinal;
      if (
        !Number.isSafeInteger(ordinal) ||
        (ordinal as number) < 0 ||
        (ordinal as number) >= prepared.length
      )
        invalid();
      const { manifestPreparedOrdinal: _ordinal, ...metadataFields } =
        sourceFields;
      const metadata = sourceMetadataSchema.parse(snapshot(metadataFields));
      source = {
        metadata,
        ordinal: ordinal as number,
        sha256: prepared[ordinal as number]!.sha256,
      };
    }
    for (const bound of [raw.maximumStatusReads, raw.maximumEventPages])
      if (!Number.isSafeInteger(bound) || (bound as number) < 1) invalid();
    const maximumStatusReads = raw.maximumStatusReads as number;
    const maximumEventPages = raw.maximumEventPages as number;
    const credentials = dataFields(raw.credentials, ['email', 'password']);
    if (
      typeof credentials.email !== 'string' ||
      typeof credentials.password !== 'string' ||
      typeof raw.publishableKey !== 'string'
    )
      invalid();
    configurationAdmitted = true;
    const accessToken = async () => {
      if (closed || condition === null)
        throw new CandidateLoadTransportError('cancelled');
      return condition.accessToken();
    };
    const portOptions = {
      apiOrigin,
      taskApiPort: raw.taskApiPort as number,
      ...scope,
      accessToken,
      signal: cancellation.signal,
    };
    const api = createA12StandardIntakeHttpAdapter({
      ...portOptions,
      storageOrigin,
      taskStoragePort: raw.taskStoragePort as number,
    });
    releases.push(api.close);
    const original = createCandidateOriginalHttpAdapter(portOptions);
    releases.push(original.close);
    const identity = createA12PlatformIdentityHttp({
      apiOrigin,
      taskApiPort: raw.taskApiPort as number,
      signal: cancellation.signal,
    });
    releases.push(identity.close);
    if (signal) {
      Reflect.apply(nativeAdd, signal, ['abort', close, { once: true }]);
      listenerAttached = true;
    }
    if (aborted(signal)) close();
    if (closed) throw new CandidateLoadTransportError('cancelled');
    const ownedFetch = globalThis.fetch.bind(globalThis);
    const boundedAuthFetch: typeof fetch = (input, init) => {
      const requestSignal = input instanceof Request ? input.signal : undefined;
      const signals = [cancellation.signal, AbortSignal.timeout(30_000)];
      if (init?.signal) signals.push(init.signal);
      if (requestSignal) signals.push(requestSignal);
      return ownedFetch(input, {
        ...init,
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
    };
    const authenticated = await authenticateCandidateLoad({
      authOrigin,
      taskAuthPort: raw.taskAuthPort as number,
      publishableKey: raw.publishableKey,
      credentials: { email: credentials.email, password: credentials.password },
      ...scope,
      // Concrete installed SDK; neither SDK constructor nor fetch/readMe is a caller input.
      createClient: (origin, key, options) =>
        createClient(origin, key, options),
      authFetch: boundedAuthFetch,
      readMe: identity.readMe,
    });
    if (closed) {
      safely(authenticated.close);
      throw new CandidateLoadTransportError('cancelled');
    }
    auth = authenticated;
    condition = await auth.verifyCondition();
    if (closed) throw new CandidateLoadTransportError('cancelled');
    if (!condition.summary.maintainerScope)
      throw new CandidateLoadTransportError('denied');
    // /me is only necessary scope/current identity. Resource/delegation/expiry
    // eligibility remains with current candidate GET and the existing HTTP routes.
    const options: A12FreshIntakeOptions = Object.freeze({
      dataset,
      scope,
      prepared: Object.freeze([...prepared]),
      idempotencyKeys,
      createIngestionInput: (orderedAssetIds: readonly string[]) => {
        if (closed || orderedAssetIds.length !== prepared.length)
          throw new CandidateLoadTransportError('cancelled');
        return CreateIngestionInputSchema.parse({
          assetIds: [...orderedAssetIds],
          ownerProjectId: scope.projectId,
          intendedUses: [...selection.intendedUses],
          requestedSecurityLevel: selection.requestedSecurityLevel,
          ...(source === undefined
            ? {}
            : {
                sourceRegistration: {
                  ...source.metadata,
                  manifestAssetId: orderedAssetIds[source.ordinal],
                  manifestSha256: source.sha256,
                },
              }),
        });
      },
      api,
      original,
      createInventory: (
        input: Parameters<A12FreshIntakeOptions['createInventory']>[0],
      ) => {
        if (closed) throw new CandidateLoadTransportError('cancelled');
        const adapter = createCandidateLoadHttpAdapter(portOptions);
        try {
          const inventory = createCandidateInventoryCollector({
            ...input,
            adapter,
            signal: cancellation.signal,
          });
          releases.push(inventory.close);
          return inventory;
        } catch (error) {
          const reason = boundedFailure(error, false);
          safely(adapter.close);
          throw new CandidateLoadTransportError(reason);
        }
      },
      maximumStatusReads,
      maximumEventPages,
      signal: cancellation.signal,
    });
    return Object.freeze({ options, close });
  } catch (error) {
    const reason = boundedFailure(error, configurationAdmitted);
    close();
    throw new CandidateLoadTransportError(reason);
  }
}
