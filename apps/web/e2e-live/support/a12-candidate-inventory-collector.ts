import { createHash } from 'node:crypto';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateReferenceSchema,
  candidateSavedReferenceKey,
  jsonUtf8Bytes,
} from '@wiser/data-contracts';
import type {
  IngestionCandidateAssetPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';
import {
  CandidateLoadTransportError,
  LOAD_PAGE_BYTES,
  canonicalLoadContent,
  immutableLoadRequest,
  pageFingerprint,
} from './a12-candidate-load-driver.ts';
import type {
  FrozenCandidateDataset,
  LoadAction,
  LoadDataset,
  LoadFailure,
  LoadPage,
  LoadReply,
  LoadRequest,
  MaterialInventory,
} from './a12-candidate-load-driver.ts';
import type { CandidateLoadHttpAdapter } from './a12-candidate-load-http.ts';

export interface CandidateInventoryPreparedAsset {
  readonly assetId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}
export interface CandidateInventoryCollectorOptions {
  readonly dataset: LoadDataset;
  /** The reference already returned by the actual getIngestion capability. */
  readonly reference: IngestionCandidateReference;
  readonly prepared: readonly CandidateInventoryPreparedAsset[];
  /** Ownership transfers after valid construction; no other adapter is closed. */
  readonly adapter: CandidateLoadHttpAdapter;
  readonly signal?: AbortSignal;
}
export type CollectedCandidateInventory = Pick<
  FrozenCandidateDataset,
  'batch' | 'materials' | 'firstPages'
>;
export type CandidateInventoryCollectionResult =
  | {
      readonly status: 'collected';
      readonly inventory: CollectedCandidateInventory;
    }
  | {
      readonly status: 'not_run';
      readonly reason: LoadFailure | 'incomplete_inventory';
    };
export interface CandidateInventoryCollector {
  readonly collect: () => Promise<CandidateInventoryCollectionResult>;
  readonly close: () => void;
  readonly diagnostics: () => {
    readonly activeCollections: number;
    readonly closed: boolean;
  };
}

const MAX_ASSETS = 10_000;
const MAX_INDEX = 2_000_000;
const MAX_PREPARED_BYTES = 32 * 1024 * 1024;
const signalDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
);
const canonicalId = (value: string) => value.toLowerCase();
const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
function aborted(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  if (typeof signalDescriptor?.get !== 'function') return fail('invalid');
  return signalDescriptor.get.call(signal) === true;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function config(
  value: CandidateInventoryCollectorOptions,
): CandidateInventoryCollectorOptions {
  try {
    if (
      !plain(value, [
        'dataset',
        'reference',
        'prepared',
        'adapter',
        'signal',
      ]) ||
      !['AUTHENTICATED-REAL', 'SYNTHETIC-S10'].includes(value.dataset) ||
      !plain(value.reference, [
        'kind',
        'ingestionId',
        'processingBatchId',
        'reviewHash',
      ]) ||
      !Array.isArray(value.prepared) ||
      Object.getPrototypeOf(value.prepared) !== Array.prototype ||
      value.prepared.length < 1 ||
      value.prepared.length > MAX_ASSETS ||
      Reflect.ownKeys(value.prepared).some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)),
      ) ||
      Object.values(Object.getOwnPropertyDescriptors(value.prepared)).some(
        (descriptor) => !Object.hasOwn(descriptor, 'value'),
      ) ||
      !plain(value.adapter, ['send', 'close', 'diagnostics']) ||
      typeof value.adapter.send !== 'function' ||
      typeof value.adapter.close !== 'function' ||
      typeof value.adapter.diagnostics !== 'function' ||
      (value.signal !== undefined && !(value.signal instanceof AbortSignal))
    )
      return fail('invalid');
    if (value.signal !== undefined) aborted(value.signal);
    const reference = IngestionCandidateReferenceSchema.safeParse(
      value.reference,
    );
    if (!reference.success) return fail('invalid');
    const ids = new Set<string>();
    const prepared: CandidateInventoryPreparedAsset[] = [];
    for (let index = 0; index < value.prepared.length; index++) {
      if (!Object.hasOwn(value.prepared, index)) return fail('invalid');
      const asset: unknown = value.prepared[index];
      if (
        !plain(asset, ['assetId', 'sha256', 'sizeBytes']) ||
        typeof asset.assetId !== 'string' ||
        !IngestionCandidateReferenceSchema.shape.ingestionId.safeParse(
          asset.assetId,
        ).success ||
        typeof asset.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        typeof asset.sizeBytes !== 'number' ||
        !Number.isSafeInteger(asset.sizeBytes) ||
        asset.sizeBytes < 1 ||
        asset.sizeBytes > MAX_PREPARED_BYTES ||
        ids.has(canonicalId(asset.assetId))
      )
        return fail('invalid');
      ids.add(canonicalId(asset.assetId));
      prepared.push(
        Object.freeze({
          assetId: asset.assetId,
          sha256: asset.sha256,
          sizeBytes: asset.sizeBytes,
        }),
      );
    }
    return Object.freeze({
      dataset: value.dataset,
      // Keep the validated caller's field order as well as its fixed values.
      reference: freeze({ ...value.reference }),
      prepared: Object.freeze(prepared),
      adapter: Object.freeze({
        send: value.adapter.send,
        close: value.adapter.close,
        diagnostics: value.adapter.diagnostics,
      }),
      ...(value.signal === undefined ? {} : { signal: value.signal }),
    });
  } catch {
    return fail('invalid');
  }
}
function failure(error: unknown): LoadFailure {
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
    // Exception text and caller accessors never become diagnostics.
  }
  return 'unavailable';
}
function statusFailure(status: number): LoadFailure {
  return status === 401 || status === 403
    ? 'denied'
    : [404, 409, 410].includes(status)
      ? 'stale'
      : [413, 415, 422].includes(status)
        ? 'invalid'
        : 'unavailable';
}
function safeJson(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > 800_000 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= LOAD_PAGE_BYTES;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      Array.isArray(item)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return false;
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        !walk(descriptor.value, depth + 1)
      )
        return false;
    }
    seen.delete(item);
    return true;
  };
  return walk(value, 0);
}
function entries(page: LoadPage) {
  return 'assets' in page
    ? page.assets
    : 'records' in page
      ? page.records
      : page.features;
}
function validatePage(request: LoadRequest, reply: LoadReply): LoadPage {
  try {
    if (
      reply === null ||
      typeof reply !== 'object' ||
      ![Object.prototype, null].includes(
        Object.getPrototypeOf(reply) as object | null,
      )
    )
      return fail('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(reply);
    const boundary: unknown = descriptors.boundary?.value;
    const status: unknown = descriptors.status?.value;
    if (
      boundary !== 'api-http' ||
      typeof status !== 'number' ||
      !Number.isInteger(status)
    )
      return fail('invalid');
    // A denied/stale/error envelope is classified without evaluating its body.
    if (status !== 200) return fail(statusFailure(status));
    if (
      !plain(reply, [
        'boundary',
        'status',
        'contentType',
        'wireBytes',
        'body',
      ]) ||
      !/^application\/json(?:\s*;|$)/i.test(reply.contentType) ||
      !Number.isSafeInteger(reply.wireBytes) ||
      reply.wireBytes < 0 ||
      reply.wireBytes > LOAD_PAGE_BYTES ||
      !safeJson(reply.body) ||
      jsonUtf8Bytes(reply.body) > LOAD_PAGE_BYTES
    )
      return fail('invalid');
    const parsed = {
      get: IngestionCandidateAssetPageSchema,
      records: IngestionCandidateRecordPageSchema,
      geometry: IngestionCandidateGeometryPageSchema,
    }[request.action].safeParse(reply.body);
    if (!parsed.success) return fail('invalid');
    const page = parsed.data;
    if (
      candidateSavedReferenceKey(page.reference) !==
        candidateSavedReferenceKey(request.reference) ||
      entries(page).length > request.first ||
      (request.after !== undefined && entries(page).length === 0) ||
      (entries(page).length === 0 && page.nextCursor !== null) ||
      (page.nextCursor !== null &&
        (page.nextCursor.length > 2048 || page.nextCursor === request.after)) ||
      ('assetId' in page &&
        canonicalId(page.assetId) !== canonicalId(request.assetId ?? '')) ||
      jsonUtf8Bytes(page) > LOAD_PAGE_BYTES
    )
      return fail('invalid');
    return page;
  } catch (error) {
    if (error instanceof CandidateLoadTransportError) throw error;
    return fail('invalid');
  }
}
function metadata(page: IngestionCandidateAssetPage) {
  return {
    reference: page.reference,
    parserVersion: page.parserVersion,
    status: page.status,
    createdAt: page.createdAt,
    totalAssetCount: page.totalAssetCount,
    knownRecordCount: page.knownRecordCount,
    knownFeatureCount: page.knownFeatureCount,
    unknownAssetCount: page.unknownAssetCount,
  };
}
interface DigestState {
  count: number;
  chain: string;
}
// Incremental form of the exported traversalContentDigest definition. Only the
// chain, bounded identity hashes and at most 200 prefix hashes remain in memory.
function startDigest(
  action: LoadAction,
  columns: MaterialInventory['columns'],
): DigestState {
  return {
    count: 0,
    chain: fingerprint({
      domain: 'a12-traversal-v1',
      action,
      columns: canonicalLoadContent(columns),
    }),
  };
}
function appendDigest(state: DigestState, entry: unknown) {
  state.chain = fingerprint({
    domain: 'a12-traversal-entry-v1',
    previous: state.chain,
    ordinal: state.count + 1,
    entry: canonicalLoadContent(entry),
  });
  state.count++;
}
function finishDigest(state: DigestState): string {
  return fingerprint({
    domain: 'a12-traversal-end-v1',
    count: state.count,
    chain: state.chain,
  });
}
function identity(id: string): string {
  return fingerprint({
    domain: 'a12-traversal-identity-v1',
    id: canonicalId(id),
  });
}
function geometryTuple(entry: {
  recordId: string;
  index: number;
  sourceId: string | null;
}): string {
  return fingerprint({
    domain: 'a12-record-geometry-v1',
    recordId: canonicalId(entry.recordId),
    index: entry.index,
    sourceId: entry.sourceId,
  });
}
function firstPrefix(
  page: LoadPage,
  expectedCount: number,
  prefix: readonly string[],
) {
  const items = entries(page);
  if (
    items.length > expectedCount ||
    (items.length === 0 && expectedCount > 0) ||
    (page.nextCursor === null && items.length !== expectedCount) ||
    (page.nextCursor !== null && items.length >= expectedCount) ||
    items.some(
      (entry, index) =>
        fingerprint(canonicalLoadContent(entry)) !== prefix[index],
    )
  )
    return fail('drift');
}

/**
 * Private preparation utility only. Collected means actual validated candidate
 * pages were summarized. It is not scan/current-permission admission, a READY
 * relabel, a verified intake receipt or formal A12. Public assets supply no byte
 * size: actual prepared/complete/original byte checks remain outside this helper.
 */
export function createCandidateInventoryCollector(
  options: CandidateInventoryCollectorOptions,
): CandidateInventoryCollector {
  const fixed = config(options);
  let closed = false;
  let finished = false;
  let activeCollections = 0;
  let adapterClosed = false;
  let listenerAttached = false;
  let firstFailure: LoadFailure | 'incomplete_inventory' | undefined;
  let cancelRead: (() => void) | undefined;
  let resultPromise: Promise<CandidateInventoryCollectionResult> | undefined;
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
        firstFailure ??= 'unavailable';
      }
    }
    if (!adapterClosed) {
      adapterClosed = true;
      try {
        fixed.adapter.close();
      } catch {
        firstFailure ??= 'unavailable';
      }
    }
  };
  const cancel = () => {
    if (finished) return;
    firstFailure ??= 'cancelled';
    closed = true;
    cancelRead?.();
    cleanup();
  };
  const guard = () => {
    if (closed || aborted(fixed.signal)) return fail('cancelled');
  };
  const send = (request: LoadRequest): Promise<LoadPage> => {
    guard();
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (kind: LoadFailure | null, reply?: LoadReply) => {
        if (settled) return;
        settled = true;
        cancelRead = undefined;
        if (kind !== null) {
          firstFailure ??= kind;
          reject(new CandidateLoadTransportError(kind));
          return;
        }
        try {
          guard();
          if (reply === undefined) return fail('invalid');
          resolve(validatePage(request, reply));
        } catch (cause) {
          const kind = failure(cause);
          firstFailure ??= kind;
          reject(new CandidateLoadTransportError(kind));
        }
      };
      cancelRead = () => settle('cancelled');
      // Both late resolution and rejection are observed after cancellation.
      Promise.resolve()
        .then(() => {
          guard();
          return fixed.adapter.send(request);
        })
        .then(
          (reply) => settle(null, reply),
          (error: unknown) => settle(failure(error)),
        );
    });
  };
  const request = (
    action: LoadAction,
    first: 50 | 200,
    assetId?: string,
    after?: string,
  ) =>
    immutableLoadRequest({
      method: 'GET',
      action,
      first,
      reference: fixed.reference,
      ...(assetId === undefined ? {} : { assetId }),
      ...(after === undefined ? {} : { after }),
    });
  const collectInventory =
    async (): Promise<CollectedCandidateInventory | null> => {
      const prepared = new Map(
        fixed.prepared.map((asset) => [
          canonicalId(asset.assetId),
          asset.sha256,
        ]),
      );
      const firstPages: CollectedCandidateInventory['firstPages'][number][] =
        [];
      const assets: FrozenCandidateDataset['batch']['assets'] = [];
      const assetIds = new Set<string>();
      const assetCursors = new Set<string>();
      let base: ReturnType<typeof metadata> | undefined;
      let after: string | undefined;
      let pageCount = 0;
      while (true) {
        if (++pageCount > fixed.prepared.length) return fail('invalid');
        const page = await send(request('get', 200, undefined, after));
        if (!('assets' in page)) return fail('invalid');
        const current = metadata(page);
        if (base === undefined) {
          base = current;
          if (base.totalAssetCount !== fixed.prepared.length)
            return fail('drift');
          firstPages.push({
            action: 'get',
            first: 200,
            assetId: null,
            digest: pageFingerprint(page, fingerprint),
          });
        } else if (
          fingerprint(canonicalLoadContent(current)) !==
          fingerprint(canonicalLoadContent(base))
        )
          return fail('drift');
        for (const asset of page.assets) {
          const id = canonicalId(asset.assetId);
          if (assetIds.has(id)) return fail('invalid');
          if (
            (asset.recordCount !== null && asset.recordCount > MAX_INDEX) ||
            (asset.featureCount !== null && asset.featureCount > MAX_INDEX)
          )
            return fail('invalid');
          if (prepared.get(id) !== asset.sourceHash) return fail('drift');
          assetIds.add(id);
          assets.push(asset);
        }
        if (assets.length > base.totalAssetCount) return fail('drift');
        if (page.nextCursor === null) {
          if (assets.length !== base.totalAssetCount) return fail('drift');
          break;
        }
        if (assets.length >= base.totalAssetCount) return fail('invalid');
        const cursor = fingerprint(page.nextCursor);
        if (assetCursors.has(cursor)) return fail('invalid');
        assetCursors.add(cursor);
        after = page.nextCursor;
      }
      if (base === undefined) return fail('invalid');
      let records = 0,
        geometry = 0,
        unknown = 0;
      for (const asset of assets) {
        if (asset.recordCount !== null) records += asset.recordCount;
        if (asset.featureCount !== null) geometry += asset.featureCount;
        if (asset.recordCount === null || asset.featureCount === null)
          unknown++;
      }
      if (
        records !== base.knownRecordCount ||
        geometry !== base.knownFeatureCount ||
        unknown !== base.unknownAssetCount ||
        assetIds.size !== prepared.size
      )
        return fail('drift');
      const batchResult = IngestionCandidateBatchSchema.safeParse({
        reference: fixed.reference,
        parserVersion: base.parserVersion,
        status: base.status,
        createdAt: base.createdAt,
        assets,
      });
      if (!batchResult.success) return fail('invalid');
      const batch = batchResult.data;
      // Null counts remain unknown; they are never changed to a zero-sized asset.
      if (unknown > 0) return null;
      const get50 = await send(request('get', 50));
      if (
        !('assets' in get50) ||
        fingerprint(canonicalLoadContent(metadata(get50))) !==
          fingerprint(canonicalLoadContent(base))
      )
        return fail('drift');
      firstPrefix(
        get50,
        assets.length,
        assets
          .slice(0, 200)
          .map((asset) => fingerprint(canonicalLoadContent(asset))),
      );
      firstPages.push({
        action: 'get',
        first: 50,
        assetId: null,
        digest: pageFingerprint(get50, fingerprint),
      });
      const materials: MaterialInventory[] = [];
      for (const asset of batch.assets) {
        guard();
        const geometryExpected = new Map<string, string>();
        let columns: MaterialInventory['columns'] | undefined;
        const digests: Partial<Record<'records' | 'geometry', string>> = {};
        for (const action of ['records', 'geometry'] as const) {
          const expectedCount =
            action === 'records' ? asset.recordCount : asset.featureCount;
          if (expectedCount === null) return null;
          const prefix: string[] = [];
          const identities = new Set<string>();
          const cursors = new Set<string>();
          let state: DigestState | undefined;
          let previousIndex = 0;
          let pages = 0;
          let after: string | undefined;
          while (true) {
            if (++pages > Math.max(1, expectedCount)) return fail('invalid');
            const page = await send(request(action, 200, asset.assetId, after));
            if (
              'assets' in page ||
              (action === 'records') !== 'records' in page
            )
              return fail('invalid');
            if ('records' in page) {
              if (columns === undefined) columns = page.columns;
              else if (JSON.stringify(columns) !== JSON.stringify(page.columns))
                return fail('drift');
            }
            state ??= startDigest(action, action === 'records' ? columns! : []);
            if (after === undefined)
              firstPages.push({
                action,
                first: 200,
                assetId: asset.assetId,
                digest: pageFingerprint(page, fingerprint),
              });
            const items = 'records' in page ? page.records : page.features;
            if (state.count + items.length > expectedCount)
              return fail('drift');
            for (const entry of items) {
              const id = identity(entry.recordId);
              if (identities.has(id) || entry.index <= previousIndex)
                return fail('invalid');
              identities.add(id);
              previousIndex = entry.index;
              if ('hasGeometry' in entry) {
                if (entry.hasGeometry)
                  geometryExpected.set(id, geometryTuple(entry));
              } else {
                if (geometryExpected.get(id) !== geometryTuple(entry))
                  return fail('drift');
                geometryExpected.delete(id);
              }
              if (prefix.length < 200)
                prefix.push(fingerprint(canonicalLoadContent(entry)));
              appendDigest(state, entry);
            }
            if (page.nextCursor === null) {
              if (state.count !== expectedCount) return fail('drift');
              digests[action] = finishDigest(state);
              break;
            }
            if (state.count >= expectedCount) return fail('invalid');
            const cursor = fingerprint(page.nextCursor);
            if (cursors.has(cursor)) return fail('invalid');
            cursors.add(cursor);
            after = page.nextCursor;
          }
          if (
            (action === 'records' &&
              geometryExpected.size !== asset.featureCount) ||
            (action === 'geometry' && geometryExpected.size !== 0)
          )
            return fail('drift');
          const first50 = await send(request(action, 50, asset.assetId));
          if (
            'assets' in first50 ||
            (action === 'records') !== 'records' in first50 ||
            ('records' in first50 &&
              JSON.stringify(columns) !== JSON.stringify(first50.columns))
          )
            return fail('drift');
          firstPrefix(first50, expectedCount, prefix);
          firstPages.push({
            action,
            first: 50,
            assetId: asset.assetId,
            digest: pageFingerprint(first50, fingerprint),
          });
        }
        if (!columns || !digests.records || !digests.geometry)
          return fail('invalid');
        materials.push({
          assetId: asset.assetId,
          columns,
          recordsDigest: digests.records,
          geometryDigest: digests.geometry,
        });
        geometryExpected.clear();
      }
      return freeze({ batch, materials, firstPages });
    };
  const execute = async (): Promise<CandidateInventoryCollectionResult> => {
    activeCollections = 1;
    let inventory: CollectedCandidateInventory | null = null;
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
      inventory = await collectInventory();
      if (inventory === null) firstFailure ??= 'incomplete_inventory';
    } catch (error) {
      firstFailure ??= failure(error);
    } finally {
      cancelRead = undefined;
      cleanup();
      activeCollections = 0;
      finished = true;
    }
    return firstFailure !== undefined || inventory === null
      ? Object.freeze({
          status: 'not_run',
          reason: firstFailure ?? 'incomplete_inventory',
        })
      : Object.freeze({ status: 'collected', inventory });
  };
  return Object.freeze({
    collect: () => {
      resultPromise ??= Promise.resolve().then(execute);
      return resultPromise;
    },
    close: cancel,
    diagnostics: () => ({ activeCollections, closed }),
  });
}
