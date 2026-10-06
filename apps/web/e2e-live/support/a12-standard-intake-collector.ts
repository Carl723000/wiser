import { createHash } from 'node:crypto';
import {
  CompleteUploadSessionInputSchema,
  CreateIngestionInputSchema,
  CreateUploadSessionInputSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateReferenceSchema,
  OperationEventPageSchema,
  UploadObjectRequestSchema,
  candidateSavedReferenceKey,
} from '@wiser/data-contracts';
import type {
  GetIngestionOutputSchema,
  OperationDto,
} from '@wiser/data-contracts';
import {
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import {
  CandidateLoadTransportError,
  canonicalLoadContent,
} from './a12-candidate-load-driver.ts';
import { redactA12StandardIntakeReply } from './a12-standard-intake-http.ts';
import type {
  A12StandardIntakeCapability,
  A12StandardIntakeReply,
  A12StandardIntakeRequest,
} from './a12-standard-intake-http.ts';
import type { A12StandardIntakeHttpAdapter } from './a12-standard-intake-http.ts';
import type { CandidateOriginalHttpAdapter } from './a12-candidate-original-http.ts';
import type {
  CandidateInventoryCollector,
  CandidateInventoryCollectorOptions,
  CandidateInventoryPreparedAsset,
} from './a12-candidate-inventory-collector.ts';
import type { A12StandardIntakeCheck } from './a12-candidate-load-runner.ts';
import type { LoadDataset, LoadFailure } from './a12-candidate-load-driver.ts';

/** Task-private consumer inputs, never a package DTO or runtime certificate. */
export interface A12FreshPreparedObject {
  /** An upload alias already safe to persist; never a private original file name. */
  readonly object: ReturnType<typeof UploadObjectRequestSchema.parse>;
  readonly bytes: Uint8Array;
  /** Hash/size of the actual UPLOADED prepared bytes, not the pre-sanitize original. */
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface A12FreshIntakeOptions {
  readonly dataset: LoadDataset;
  readonly scope: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly purpose: string;
  };
  readonly prepared: readonly A12FreshPreparedObject[];
  /** Four owned UUIDs, frozen for this attempt; never generate a retry to hide failure. */
  readonly idempotencyKeys: {
    readonly createUpload: string;
    readonly completeUpload: string;
    readonly createIngestion: string;
    readonly submitIngestion: string;
  };
  /**
   * Mechanical construction of the EXISTING public DTO after generated IDs exist.
   * Its result must be descriptor-snapshotted/schema-validated and must preserve
   * exactly the generated ordered IDs, owner project and declared input use.
   * Optional sourceRegistration remains optional. This callback proves no runtime.
   */
  readonly createIngestionInput: (
    orderedAssetIds: readonly string[],
  ) => ReturnType<typeof CreateIngestionInputSchema.parse>;
  readonly api: A12StandardIntakeHttpAdapter;
  readonly original: CandidateOriginalHttpAdapter;
  /** Calls the existing 76+4+4/84-test inventory helper; does not repeat its traversal. */
  readonly createInventory: (
    input: Pick<
      CandidateInventoryCollectorOptions,
      'dataset' | 'reference' | 'prepared'
    >,
  ) => CandidateInventoryCollector;
  /**
   * Explicit bounded collection controls, NOT new A12 performance thresholds.
   * Parent must select actual values before a live run; no implicit 5s gate.
   */
  readonly maximumStatusReads: number;
  readonly maximumEventPages: number;
  readonly signal?: AbortSignal;
}
export type A12FreshIntakeResult =
  | {
      readonly status: 'collected';
      readonly prepared: readonly CandidateInventoryPreparedAsset[];
      /** Existing runner public-receipt shape, PRIVATE MEMORY ONLY; uses safe response projections. */
      readonly receiptBytes: Uint8Array;
      /** Exact frozen inventory for runner, PRIVATE MEMORY ONLY (labels/DTO reason included). */
      readonly inventoryBytes: Uint8Array;
      /** Only safe capture hashes/counts/ordinals; no signed URL/token/raw text. */
      readonly captureBytes: Uint8Array;
      /** This first slice has NO trusted normal-runtime observer. */
      readonly standardAuthority: 'unknown';
    }
  | {
      readonly status: 'not_run' | 'failed';
      readonly reason:
        | LoadFailure
        | 'incomplete_inventory'
        | 'status_bound_exhausted'
        | 'event_bound_exhausted'
        | 'submit_transport_missing'
        | 'collector_not_implemented';
      readonly attemptedHttp: number;
    };
export interface A12StandardIntakeCollector {
  readonly collect: () => Promise<A12FreshIntakeResult>;
  /**
   * Runner-compatible closure over this owner's in-memory capture register.
   * Copyable JSON, DTO validity, hashes, READY, typed callbacks, and GET200
   * cannot issue verified. Without a separately implemented trusted normal-stack
   * scan/fingerprint observation window this slice only returns unknown/rejected.
   */
  readonly verifyStandardIntake: (
    check: A12StandardIntakeCheck,
  ) => Promise<'unknown' | 'rejected'>;
  readonly close: () => void;
  readonly diagnostics: () => { activeCollections: number; closed: boolean };
}

type IntakeReason = Extract<
  A12FreshIntakeResult,
  { status: 'failed' | 'not_run' }
>['reason'];
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const canonicalSha = (value: unknown) =>
  sha(JSON.stringify(canonicalLoadContent(value)));
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const signalDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
);
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const byteDescriptors = {
  buffer: Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer'),
  byteOffset: Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteOffset',
  ),
  byteLength: Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  ),
};
class IntakeStop extends Error {
  constructor(readonly reason: IntakeReason) {
    super('Intake collection could not complete');
  }
}
function fail(reason: IntakeReason = 'invalid'): never {
  throw new IntakeStop(reason);
}
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
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        (allowed !== undefined && !allowed.includes(key)),
    )
  )
    return fail();
  const out: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) return fail();
    out[key] = descriptor.value;
  }
  return out;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
    ) ||
    Object.values(descriptors).some((entry) => !Object.hasOwn(entry, 'value'))
  )
    return fail();
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) return fail();
  return value as readonly unknown[];
}
function snapshot(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 1_000_000 || depth > 64) return fail();
  if (
    value === null ||
    ['string', 'boolean', 'undefined'].includes(typeof value)
  )
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail();
    return value;
  }
  if (Array.isArray(value))
    return Object.freeze(
      array(value).map((item) => snapshot(item, depth + 1, budget)),
    );
  const source = fields(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source))
    Object.defineProperty(out, key, {
      value: snapshot(item, depth + 1, budget),
      enumerable: true,
    });
  return Object.freeze(out);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function copyBytes(value: unknown, maximum = 32 * 1024 * 1024): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    typeof byteDescriptors.buffer?.get !== 'function' ||
    typeof byteDescriptors.byteOffset?.get !== 'function' ||
    typeof byteDescriptors.byteLength?.get !== 'function'
  )
    return fail();
  const byteLength: unknown = byteDescriptors.byteLength.get.call(value);
  const byteOffset: unknown = byteDescriptors.byteOffset.get.call(value);
  const buffer: unknown = byteDescriptors.buffer.get.call(value);
  if (
    typeof byteLength !== 'number' ||
    byteLength > maximum ||
    typeof byteOffset !== 'number' ||
    !(buffer instanceof ArrayBuffer || buffer instanceof SharedArrayBuffer)
  )
    return fail();
  return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
}
function aborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (typeof signalDescriptor?.get !== 'function') return fail();
  return signalDescriptor.get.call(signal) === true;
}
function reasonOf(error: unknown): IntakeReason {
  if (error instanceof IntakeStop) return error.reason;
  try {
    if (error instanceof CandidateLoadTransportError) {
      const kind: unknown = Object.getOwnPropertyDescriptor(
        error,
        'kind',
      )?.value;
      if (
        typeof kind === 'string' &&
        [
          'denied',
          'stale',
          'invalid',
          'unavailable',
          'cancelled',
          'drift',
          'instrumentation',
        ].includes(kind)
      )
        return kind as LoadFailure;
    }
  } catch {
    /* Caller error text/accessors are never diagnostics. */
  }
  return 'unavailable';
}
function configuration(options: A12FreshIntakeOptions): A12FreshIntakeOptions {
  try {
    const raw = fields(options, [
      'dataset',
      'scope',
      'prepared',
      'idempotencyKeys',
      'createIngestionInput',
      'api',
      'original',
      'createInventory',
      'maximumStatusReads',
      'maximumEventPages',
      'signal',
    ]);
    const scope = fields(raw.scope, ['tenantId', 'projectId', 'purpose']);
    const keys = fields(raw.idempotencyKeys, [
      'createUpload',
      'completeUpload',
      'createIngestion',
      'submitIngestion',
    ]);
    const api = fields(raw.api, ['send', 'put', 'close', 'diagnostics']);
    const original = fields(raw.original, ['read', 'close', 'diagnostics']);
    if (
      !['AUTHENTICATED-REAL', 'SYNTHETIC-S10'].includes(
        raw.dataset as string,
      ) ||
      !PlatformUuidSchema.safeParse(scope.tenantId).success ||
      !PlatformUuidSchema.safeParse(scope.projectId).success ||
      !PlatformPurposeSchema.safeParse(scope.purpose).success ||
      Object.keys(keys).length !== 4 ||
      Object.values(keys).some(
        (key) => !PlatformUuidSchema.safeParse(key).success,
      ) ||
      new Set(Object.values(keys)).size !== 4 ||
      typeof raw.createIngestionInput !== 'function' ||
      typeof raw.createInventory !== 'function' ||
      ['send', 'put', 'close', 'diagnostics'].some(
        (key) => typeof api[key] !== 'function',
      ) ||
      ['read', 'close', 'diagnostics'].some(
        (key) => typeof original[key] !== 'function',
      ) ||
      !Number.isSafeInteger(raw.maximumStatusReads) ||
      (raw.maximumStatusReads as number) < 1 ||
      !Number.isSafeInteger(raw.maximumEventPages) ||
      (raw.maximumEventPages as number) < 1 ||
      (raw.signal !== undefined && !(raw.signal instanceof AbortSignal))
    )
      return fail();
    const prepared = array(raw.prepared);
    if (prepared.length < 1 || prepared.length > 1000) return fail();
    const copies = prepared.map((entry) => {
      const item = fields(entry, ['object', 'bytes', 'sha256', 'sizeBytes']);
      const object = UploadObjectRequestSchema.parse(snapshot(item.object));
      const bytes = copyBytes(item.bytes);
      if (
        bytes.length < 1 ||
        bytes.length !== item.sizeBytes ||
        bytes.length !== object.sizeBytes ||
        typeof item.sha256 !== 'string' ||
        object.sha256 !== item.sha256 ||
        sha(bytes) !== item.sha256
      )
        return fail();
      return Object.freeze({
        object: freeze(object),
        bytes,
        sha256: item.sha256,
        sizeBytes: bytes.length,
      });
    });
    if (raw.signal !== undefined) aborted(raw.signal);
    return Object.freeze({
      dataset: raw.dataset as LoadDataset,
      scope: Object.freeze({
        tenantId: scope.tenantId as string,
        projectId: scope.projectId as string,
        purpose: scope.purpose as string,
      }),
      prepared: Object.freeze(copies),
      idempotencyKeys: Object.freeze({
        ...keys,
      }) as A12FreshIntakeOptions['idempotencyKeys'],
      createIngestionInput:
        raw.createIngestionInput as A12FreshIntakeOptions['createIngestionInput'],
      createInventory:
        raw.createInventory as A12FreshIntakeOptions['createInventory'],
      api: Object.freeze({ ...api }) as unknown as A12StandardIntakeHttpAdapter,
      original: Object.freeze({
        ...original,
      }) as unknown as CandidateOriginalHttpAdapter,
      maximumStatusReads: raw.maximumStatusReads as number,
      maximumEventPages: raw.maximumEventPages as number,
      ...(raw.signal === undefined ? {} : { signal: raw.signal }),
    });
  } catch {
    throw new CandidateLoadTransportError('invalid');
  }
}
function ordered(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual.map((id) => id.toLowerCase())).size === actual.length &&
    actual.every((id, index) => {
      const expectedId = expected[index];
      return expectedId !== undefined && sameId(id, expectedId);
    })
  );
}
function inventoryShape(value: unknown) {
  const raw = fields(snapshot(value), ['batch', 'materials', 'firstPages']);
  const batch = IngestionCandidateBatchSchema.parse(raw.batch);
  const materials = array(raw.materials).map((value) => {
    const entry = fields(value, [
      'assetId',
      'columns',
      'recordsDigest',
      'geometryDigest',
    ]);
    if (
      typeof entry.assetId !== 'string' ||
      !PlatformUuidSchema.safeParse(entry.assetId).success ||
      typeof entry.recordsDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.recordsDigest) ||
      typeof entry.geometryDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.geometryDigest)
    )
      return fail();
    const page = IngestionCandidateRecordPageSchema.parse({
      reference: batch.reference,
      assetId: entry.assetId,
      columns: entry.columns,
      records: [],
      nextCursor: null,
    });
    return {
      assetId: entry.assetId,
      columns: page.columns,
      recordsDigest: entry.recordsDigest,
      geometryDigest: entry.geometryDigest,
    };
  });
  const expected = new Set(['get/50/', 'get/200/']);
  for (const asset of batch.assets)
    for (const action of ['records', 'geometry'])
      for (const first of [50, 200])
        expected.add(`${action}/${first}/${asset.assetId.toLowerCase()}`);
  const firstPages = array(raw.firstPages).map((value) => {
    const entry = fields(value, ['action', 'first', 'assetId', 'digest']);
    if (
      !['get', 'records', 'geometry'].includes(entry.action as string) ||
      ![50, 200].includes(entry.first as number) ||
      (entry.assetId !== null &&
        (typeof entry.assetId !== 'string' ||
          !PlatformUuidSchema.safeParse(entry.assetId).success)) ||
      typeof entry.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.digest)
    )
      return fail();
    const action = entry.action as 'get' | 'records' | 'geometry';
    const assetId = entry.assetId;
    if ((action === 'get') !== (assetId === null)) return fail();
    const key = `${action}/${entry.first as number}/${assetId?.toLowerCase() ?? ''}`;
    if (!expected.delete(key)) return fail();
    return {
      action,
      first: entry.first as 50 | 200,
      assetId,
      digest: entry.digest,
    };
  });
  if (
    expected.size !== 0 ||
    !ordered(
      materials.map((entry) => entry.assetId),
      batch.assets.map((asset) => asset.assetId),
    )
  )
    return fail();
  return freeze({ batch, materials, firstPages });
}

/** Complete private intake collection; trusted normal-runtime observation is a later gate. */
export function createA12StandardIntakeCollector(
  options: A12FreshIntakeOptions,
): A12StandardIntakeCollector {
  const fixed = configuration(options);
  let closed = false,
    finished = false,
    activeCollections = 0,
    attemptedHttp = 0;
  let apiClosed = false,
    originalClosed = false,
    inventoryClosed = false,
    listenerAttached = false;
  let inventoryClose: (() => void) | undefined;
  let cancelPending: (() => void) | undefined;
  let firstReason: IntakeReason | undefined;
  let resultPromise: Promise<A12FreshIntakeResult> | undefined;
  let owned:
    | {
        receipt: string;
        receiptBytes: string;
        inventory: string;
        inventoryBytes: string;
        capture: string;
        prepared: string;
      }
    | undefined;
  const captures: Record<string, unknown>[] = [];
  const cleanup = () => {
    closed = true;
    if (listenerAttached && fixed.signal) {
      listenerAttached = false;
      try {
        EventTarget.prototype.removeEventListener.call(
          fixed.signal,
          'abort',
          cancel,
        );
      } catch {
        firstReason ??= 'unavailable';
      }
    }
    for (const release of [
      () => {
        if (!inventoryClosed && inventoryClose) {
          inventoryClosed = true;
          inventoryClose();
        }
      },
      () => {
        if (!apiClosed) {
          apiClosed = true;
          fixed.api.close();
        }
      },
      () => {
        if (!originalClosed) {
          originalClosed = true;
          fixed.original.close();
        }
      },
    ])
      try {
        release();
      } catch {
        firstReason ??= 'unavailable';
      }
    for (const entry of fixed.prepared) entry.bytes.fill(0);
  };
  const cancel = () => {
    if (finished) return;
    firstReason ??= 'cancelled';
    closed = true;
    cancelPending?.();
    cleanup();
  };
  const guard = () => {
    if (firstReason !== undefined) return fail(firstReason);
    if (closed || aborted(fixed.signal)) return fail('cancelled');
  };
  const invoke = <T>(call: () => Promise<T>, http = true): Promise<T> => {
    guard();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (error: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        cancelPending = undefined;
        if (error !== undefined) {
          firstReason ??= reasonOf(error);
          reject(new IntakeStop(firstReason));
          return;
        }
        try {
          guard();
          resolve(value as T);
        } catch (cause) {
          firstReason ??= reasonOf(cause);
          reject(new IntakeStop(firstReason));
        }
      };
      cancelPending = () => settle(new IntakeStop(firstReason ?? 'cancelled'));
      Promise.resolve()
        .then(() => {
          guard();
          if (http) attemptedHttp++;
          return call();
        })
        .then(
          (value) => settle(undefined, value),
          (cause: unknown) => settle(cause),
        );
    });
  };
  const send = async <C extends A12StandardIntakeCapability>(
    request: A12StandardIntakeRequest<C>,
  ) => {
    const reply = snapshot(
      await invoke(() => fixed.api.send(request)),
    ) as A12StandardIntakeReply<C>;
    const projection = redactA12StandardIntakeReply(reply);
    if (reply.capabilityId !== request.capabilityId) return fail();
    captures.push({
      ordinal: captures.length + 1,
      capabilityId: request.capabilityId,
      status: reply.status,
      requestSha256: canonicalSha(request.input),
      wireBytes: projection.wireBytes,
      wireSha256: projection.wireSha256,
      projectionSha256: projection.projectionSha256,
      redactedFields: projection.redactedFields,
    });
    return { body: reply.body, projected: projection.body };
  };
  const checkScope = (value: { tenantId: string; projectId: string }) => {
    if (
      !sameId(value.tenantId, fixed.scope.tenantId) ||
      !sameId(value.projectId, fixed.scope.projectId)
    )
      return fail();
  };
  const checkOperation = (value: OperationDto, expectedId?: string) => {
    checkScope(value);
    if (
      value.capabilityId !== 'data.ingestion.create' ||
      !sameId(value.resource, `operation://${value.operationId}`) ||
      (expectedId !== undefined && !sameId(value.operationId, expectedId))
    )
      return fail();
    if (value.status === 'FAILED') return fail('unavailable');
    if (value.status === 'CANCELLED') return fail('cancelled');
  };
  const execute = async (): Promise<A12FreshIntakeResult> => {
    activeCollections = 1;
    let collected:
      Extract<A12FreshIntakeResult, { status: 'collected' }> | undefined;
    try {
      guard();
      if (fixed.signal) {
        EventTarget.prototype.addEventListener.call(
          fixed.signal,
          'abort',
          cancel,
          { once: true },
        );
        listenerAttached = true;
      }
      guard();
      const uploadInput = freeze(
        CreateUploadSessionInputSchema.parse({
          ownerProjectId: fixed.scope.projectId,
          objects: fixed.prepared.map((entry) => entry.object),
          preferredMode: 'PRESIGNED_PUT',
        }),
      );
      const upload = await send({
        capabilityId: 'data.uploadSession.create',
        input: uploadInput,
        idempotencyKey: fixed.idempotencyKeys.createUpload,
      });
      const session = upload.body.uploadSession;
      checkScope(session);
      const ids = session.assetIds;
      if (
        session.status !== 'OPEN' ||
        ids.length !== fixed.prepared.length ||
        !ordered(
          upload.body.uploadTargets.map((target) => target.assetId),
          ids,
        )
      )
        return fail();
      const prepared = freeze(
        ids.map((assetId, index) => {
          const entry = fixed.prepared[index];
          if (entry === undefined) return fail();
          return { assetId, sha256: entry.sha256, sizeBytes: entry.sizeBytes };
        }),
      );
      for (const [index, target] of upload.body.uploadTargets.entries()) {
        const expected = fixed.prepared[index];
        if (expected === undefined) return fail();
        const headers = fields(target.headers, [
          'content-length',
          'content-type',
          'x-amz-meta-sha256',
        ]);
        if (
          target.method !== 'PRESIGNED_PUT' ||
          headers['content-length'] !== String(expected.sizeBytes) ||
          headers['content-type'] !== expected.object.mediaType ||
          headers['x-amz-meta-sha256'] !== expected.sha256
        )
          return fail();
      }
      const objects = [];
      for (const [index, target] of upload.body.uploadTargets.entries()) {
        const expected = fixed.prepared[index];
        if (expected === undefined) return fail();
        const put = fields(
          snapshot(
            await invoke(() =>
              fixed.api.put({
                target,
                bytes: expected.bytes,
                sha256: expected.sha256,
                sizeBytes: expected.sizeBytes,
              }),
            ),
          ),
          [
            'status',
            'requestBytes',
            'requestSha256',
            'wireBytes',
            'wireSha256',
            'etag',
          ],
        );
        if (
          put.status !== 200 ||
          put.requestBytes !== expected.sizeBytes ||
          put.requestSha256 !== expected.sha256 ||
          !Number.isSafeInteger(put.wireBytes) ||
          (put.wireBytes as number) < 0 ||
          typeof put.wireSha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(put.wireSha256)
        )
          return fail('drift');
        captures.push({
          ordinal: captures.length + 1,
          action: 'put',
          status: 200,
          requestBytes: expected.sizeBytes,
          requestSha256: expected.sha256,
          wireBytes: put.wireBytes,
          wireSha256: put.wireSha256,
        });
        objects.push({
          assetId: target.assetId,
          sha256: expected.sha256,
          sizeBytes: expected.sizeBytes,
        });
      }
      const completeInput = freeze(
        CompleteUploadSessionInputSchema.parse({
          uploadSessionId: session.uploadSessionId,
          expectedVersion: session.version,
          objects,
        }),
      );
      const complete = await send({
        capabilityId: 'data.uploadSession.complete',
        input: completeInput,
        ifMatch: `"v${session.version}"`,
        idempotencyKey: fixed.idempotencyKeys.completeUpload,
      });
      checkScope(complete.body.uploadSession);
      if (
        !sameId(
          complete.body.uploadSession.uploadSessionId,
          session.uploadSessionId,
        ) ||
        complete.body.uploadSession.status !== 'COMPLETED' ||
        complete.body.uploadSession.version <= session.version ||
        !ordered(complete.body.uploadSession.assetIds, ids)
      )
        return fail();
      guard();
      const createInput = freeze(
        CreateIngestionInputSchema.parse(
          snapshot(fixed.createIngestionInput(Object.freeze([...ids]))),
        ),
      );
      if (
        !sameId(createInput.ownerProjectId, fixed.scope.projectId) ||
        !ordered(createInput.assetIds, ids)
      )
        return fail();
      const created = await send({
        capabilityId: 'data.ingestion.create',
        input: createInput,
        idempotencyKey: fixed.idempotencyKeys.createIngestion,
      });
      const operation = created.body.operation;
      checkOperation(operation);
      if (operation.status !== 'WAITING_INPUT') return fail();
      const checkIngestion = (
        value: ReturnType<typeof GetIngestionOutputSchema.parse>,
      ) => {
        checkScope(value.ingestion);
        if (
          !sameId(value.ingestion.ingestionId, created.body.ingestionId) ||
          value.ingestion.operationId === undefined ||
          !sameId(value.ingestion.operationId, operation.operationId) ||
          !ordered(value.ingestion.assetIds, ids) ||
          canonicalSha(value.ingestion.intendedUses) !==
            canonicalSha(createInput.intendedUses) ||
          value.ingestion.requestedSecurityLevel !==
            createInput.requestedSecurityLevel ||
          canonicalSha(value.ingestion.sourceRegistration ?? null) !==
            canonicalSha(createInput.sourceRegistration ?? null)
        )
          return fail();
        if (value.ingestion.state === 'FAILED') return fail('unavailable');
        if (value.ingestion.state === 'CANCELLED') return fail('cancelled');
        if (
          value.candidateReference !== null &&
          !sameId(
            value.candidateReference.ingestionId,
            created.body.ingestionId,
          )
        )
          return fail();
      };
      const current = () =>
        send({
          capabilityId: 'data.ingestion.get',
          input: { ingestionId: created.body.ingestionId },
        });
      const preSubmit = await current();
      checkIngestion(preSubmit.body);
      if (preSubmit.body.ingestion.state !== 'RECEIVED') return fail();
      const submit = await send({
        capabilityId: 'data.ingestion.submit',
        input: {
          ingestionId: created.body.ingestionId,
          expectedVersion: preSubmit.body.ingestion.version,
        },
        ifMatch: `"v${preSubmit.body.ingestion.version}"`,
        idempotencyKey: fixed.idempotencyKeys.submitIngestion,
      });
      checkOperation(submit.body.operation, operation.operationId);
      if (
        submit.body.operation.status !== 'RUNNING' ||
        submit.body.operation.version <= operation.version
      )
        return fail();
      let finalGet: Awaited<ReturnType<typeof current>> | undefined;
      let finalOperation: Awaited<ReturnType<typeof readOperation>> | undefined;
      const readOperation = () =>
        send({
          capabilityId: 'data.operation.get',
          input: { operationId: operation.operationId },
        });
      for (let round = 0; round < fixed.maximumStatusReads; round++) {
        const latest = await current();
        checkIngestion(latest.body);
        if (latest.body.ingestion.version < preSubmit.body.ingestion.version)
          return fail('drift');
        const latestOperation = await readOperation();
        checkOperation(latestOperation.body, operation.operationId);
        if (latestOperation.body.version < submit.body.operation.version)
          return fail('drift');
        if (latest.body.candidateReference !== null) {
          finalGet = latest;
          finalOperation = latestOperation;
          break;
        }
      }
      if (
        !finalGet ||
        !finalOperation ||
        finalGet.body.candidateReference === null
      )
        return fail('status_bound_exhausted');
      const reference = freeze(
        IngestionCandidateReferenceSchema.parse(
          finalGet.body.candidateReference,
        ),
      );
      const eventIds = new Set<string>(),
        cursors = new Set<string>();
      const events: ReturnType<typeof OperationEventPageSchema.parse>['items'] =
        [];
      let sequence = 0,
        after: string | undefined,
        eventsComplete = false;
      for (let page = 0; page < fixed.maximumEventPages; page++) {
        const snapshot = await send({
          capabilityId: 'data.operation.events',
          input: {
            operationId: operation.operationId,
            first: 200,
            ...(after === undefined ? {} : { after }),
          },
        });
        if (
          snapshot.body.nextCursor !== undefined &&
          snapshot.body.items.length === 0
        )
          return fail();
        for (const event of snapshot.body.items) {
          if (
            !sameId(event.operationId, operation.operationId) ||
            event.sequence <= sequence ||
            event.operationVersion > finalOperation.body.version ||
            eventIds.has(event.eventId.toLowerCase()) ||
            events.length >= 10_000
          )
            return fail();
          eventIds.add(event.eventId.toLowerCase());
          sequence = event.sequence;
        }
        events.push(...snapshot.projected.items);
        if (snapshot.body.nextCursor === undefined) {
          eventsComplete = true;
          break;
        }
        const digest = sha(snapshot.body.nextCursor);
        if (cursors.has(digest)) return fail();
        cursors.add(digest);
        after = snapshot.body.nextCursor;
      }
      if (!eventsComplete) return fail('event_bound_exhausted');
      guard();
      const returned: unknown = fixed.createInventory({
        dataset: fixed.dataset,
        reference,
        prepared,
      });
      // Retain this owned release even when another returned descriptor is malformed.
      const release =
        returned !== null && typeof returned === 'object'
          ? Object.getOwnPropertyDescriptor(returned, 'close')
          : undefined;
      if (
        release &&
        Object.hasOwn(release, 'value') &&
        typeof release.value === 'function'
      )
        inventoryClose = release.value as () => void;
      const inventoryPort = fields(returned, [
        'collect',
        'close',
        'diagnostics',
      ]);
      if (
        typeof inventoryPort.collect !== 'function' ||
        typeof inventoryPort.close !== 'function' ||
        typeof inventoryPort.diagnostics !== 'function'
      )
        return fail();
      const collectInventory =
        inventoryPort.collect as CandidateInventoryCollector['collect'];
      const inventoryResult = fields(
        snapshot(await invoke(() => collectInventory(), false)),
        ['status', 'inventory', 'reason'],
      );
      if (inventoryResult.status === 'not_run') {
        const reason = inventoryResult.reason;
        if (
          typeof reason !== 'string' ||
          ![
            'denied',
            'stale',
            'invalid',
            'unavailable',
            'cancelled',
            'drift',
            'instrumentation',
            'incomplete_inventory',
          ].includes(reason)
        )
          return fail();
        return fail(reason as IntakeReason);
      }
      if (inventoryResult.status !== 'collected') return fail();
      const inventory = inventoryShape(inventoryResult.inventory);
      if (
        candidateSavedReferenceKey(inventory.batch.reference) !==
          candidateSavedReferenceKey(reference) ||
        !ordered(
          inventory.batch.assets.map((asset) => asset.assetId),
          ids,
        )
      )
        return fail();
      for (const [index, asset] of inventory.batch.assets.entries()) {
        const expected = prepared[index];
        if (expected === undefined) return fail();
        if (asset.sourceHash !== expected.sha256) return fail('drift');
        if (asset.recordCount === null || asset.featureCount === null)
          return fail('incomplete_inventory');
      }
      for (const asset of prepared) {
        const read = fields(
          snapshot(
            await invoke(() =>
              fixed.original.read({
                reference,
                assetId: asset.assetId,
                expectedSha256: asset.sha256,
                expectedSizeBytes: asset.sizeBytes,
              }),
            ),
          ),
          ['status', 'sha256', 'sizeBytes'],
        );
        if (
          read.status !== 200 ||
          read.sha256 !== asset.sha256 ||
          read.sizeBytes !== asset.sizeBytes
        )
          return fail('drift');
        captures.push({
          ordinal: captures.length + 1,
          action: 'original',
          status: 200,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
        });
      }
      guard();
      const receipt = freeze({
        createUpload: { input: uploadInput, output: upload.projected },
        completeUpload: { input: completeInput, output: complete.projected },
        createIngestion: { input: createInput, output: created.projected },
        getIngestion: finalGet.projected,
        operation: finalOperation.projected,
        events: OperationEventPageSchema.parse({ items: events }),
      });
      const receiptBytes = Buffer.from(JSON.stringify(receipt));
      const inventoryBytes = Buffer.from(JSON.stringify(inventory));
      const captureBytes = Buffer.from(
        JSON.stringify({
          kind: 'owned-standard-intake-collection',
          version: 1,
          standardAuthority: 'unknown',
          receiptSha256: sha(receiptBytes),
          inventorySha256: sha(inventoryBytes),
          preparedSha256: canonicalSha(prepared),
          captures,
        }),
      );
      owned = {
        receipt: canonicalSha(receipt),
        receiptBytes: sha(receiptBytes),
        inventory: canonicalSha(inventory),
        inventoryBytes: sha(inventoryBytes),
        capture: sha(captureBytes),
        prepared: canonicalSha(prepared),
      };
      collected = Object.freeze({
        status: 'collected',
        prepared,
        receiptBytes,
        inventoryBytes,
        captureBytes,
        standardAuthority: 'unknown',
      });
    } catch (error) {
      firstReason ??= reasonOf(error);
    } finally {
      finished = true;
      cancelPending = undefined;
      cleanup();
      activeCollections = 0;
    }
    if (firstReason !== undefined || collected === undefined) {
      owned = undefined;
      return Object.freeze({
        status: attemptedHttp === 0 ? 'not_run' : 'failed',
        reason: firstReason ?? 'unavailable',
        attemptedHttp,
      });
    }
    return collected;
  };
  return Object.freeze({
    collect: () => {
      resultPromise ??= Promise.resolve().then(execute);
      return resultPromise.then((result) =>
        result.status !== 'collected'
          ? result
          : Object.freeze({
              ...result,
              receiptBytes: Uint8Array.from(result.receiptBytes),
              inventoryBytes: Uint8Array.from(result.inventoryBytes),
              captureBytes: Uint8Array.from(result.captureBytes),
            }),
      );
    },
    verifyStandardIntake: (
      check: A12StandardIntakeCheck,
    ): Promise<'unknown' | 'rejected'> => {
      try {
        if (!owned) return Promise.resolve('rejected');
        const raw = fields(check, [
          'receipt',
          'captureBytes',
          'prepared',
          'inventory',
        ]);
        const inventory = fields(snapshot(raw.inventory), [
          'dataset',
          'provenance',
          'batch',
          'materials',
          'firstPages',
        ]);
        const provenance = fields(inventory.provenance, [
          'kind',
          'receiptSha256',
          'inventorySha256',
        ]);
        if (
          inventory.dataset !== fixed.dataset ||
          provenance.kind !== 'standard-intake-http' ||
          provenance.receiptSha256 !== owned.receiptBytes ||
          provenance.inventorySha256 !== owned.inventoryBytes ||
          sha(copyBytes(raw.captureBytes)) !== owned.capture ||
          canonicalSha(snapshot(raw.receipt)) !== owned.receipt ||
          canonicalSha(snapshot(raw.prepared)) !== owned.prepared ||
          canonicalSha({
            batch: inventory.batch,
            materials: inventory.materials,
            firstPages: inventory.firstPages,
          }) !== owned.inventory
        )
          return Promise.resolve('rejected');
        // Owned HTTP/bytes and valid DTOs do not observe a normal scanner transaction.
        return Promise.resolve('unknown');
      } catch {
        return Promise.resolve('rejected');
      }
    },
    close: cancel,
    diagnostics: () => ({ activeCollections, closed }),
  });
}
