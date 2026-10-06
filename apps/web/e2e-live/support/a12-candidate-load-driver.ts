import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateReadInputSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateRecordsInputSchema,
  candidateSavedReferenceKey,
  jsonUtf8Bytes,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import type {
  IngestionCandidateAssetPage,
  IngestionCandidateBatch,
  IngestionCandidateGeometryPage,
  IngestionCandidateRecordPage,
  IngestionCandidateReference,
} from '@wiser/data-contracts';

/** This utility measures reads; it does not authorize, seed or publish data. */
export type LoadDataset = 'AUTHENTICATED-REAL' | 'SYNTHETIC-S10';
export type LoadAction = 'get' | 'records' | 'geometry';
export type LoadPage =
  | IngestionCandidateAssetPage
  | IngestionCandidateRecordPage
  | IngestionCandidateGeometryPage;
export type LoadFailure =
  | 'denied'
  | 'stale'
  | 'invalid'
  | 'unavailable'
  | 'cancelled'
  | 'drift'
  | 'instrumentation';

export interface LoadCondition {
  readonly dataset: LoadDataset;
  readonly action: LoadAction;
  readonly first: 50 | 200;
  readonly concurrency: 1 | 4 | 8;
}
export interface MaterialInventory {
  readonly assetId: string;
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly recordsDigest: string;
  readonly geometryDigest: string;
}
export interface FrozenCandidateDataset {
  readonly dataset: LoadDataset;
  readonly provenance: {
    readonly kind: 'standard-intake-http';
    readonly receiptSha256: string;
    readonly inventorySha256: string;
  };
  readonly batch: IngestionCandidateBatch;
  readonly materials: readonly MaterialInventory[];
  readonly firstPages: readonly {
    readonly action: LoadAction;
    readonly first: 50 | 200;
    readonly assetId: string | null;
    readonly digest: string;
  }[];
}
export type FrozenInputResult =
  | { readonly status: 'ready'; readonly input: FrozenCandidateDataset }
  | { readonly status: 'not_run'; readonly reason: 'incomplete_inventory' };

export interface LoadRequest {
  readonly method: 'GET';
  readonly action: LoadAction;
  readonly reference: IngestionCandidateReference;
  readonly first: 50 | 200;
  readonly assetId?: string;
  readonly after?: string;
}
export interface LoadReply {
  readonly boundary: 'api-http' | 'web-bff';
  readonly status: number;
  readonly contentType: string;
  readonly wireBytes: number;
  readonly body: unknown;
}
export interface LoadPorts {
  readonly send: (request: LoadRequest) => Promise<LoadReply>;
  readonly now: () => number;
  /** Inject a deterministic SHA256 implementation; never persist its input. */
  readonly fingerprint: (value: unknown) => string;
}
export type ValidatedReply =
  | {
      readonly ok: true;
      readonly page: LoadPage;
      readonly dtoBytes: number;
    }
  | { readonly ok: false; readonly failure: LoadFailure };
export interface LoadSample {
  readonly ordinal: number;
  readonly elapsedMs: number | null;
  readonly outcome: 'completed' | LoadFailure;
  readonly wireBytes: number | null;
  readonly dtoBytes: number | null;
}
export interface LoadStatistics {
  readonly completed: number;
  readonly failed: number;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly meetsLatencyTarget: boolean;
}
export interface LoadConditionResult {
  readonly condition: LoadCondition;
  readonly status: 'passed' | 'failed' | 'not_run';
  readonly reason: 'incomplete_inventory' | 'condition_invalid' | null;
  readonly warmup: readonly LoadSample[];
  readonly measured: readonly LoadSample[];
  readonly statistics: LoadStatistics;
}

export const LOAD_PAGE_BYTES = 3 * 1024 * 1024;

const digestValid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, 'value'),
    )
  );
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
function loadCondition(value: unknown): LoadCondition | null {
  if (
    !isObject(value) ||
    !exactKeys(value, ['dataset', 'action', 'first', 'concurrency']) ||
    (value['dataset'] !== 'AUTHENTICATED-REAL' &&
      value['dataset'] !== 'SYNTHETIC-S10') ||
    (value['action'] !== 'get' &&
      value['action'] !== 'records' &&
      value['action'] !== 'geometry') ||
    ![50, 200].includes(value['first'] as number) ||
    ![1, 4, 8].includes(value['concurrency'] as number)
  )
    return null;
  return {
    dataset: value['dataset'],
    action: value['action'],
    first: value['first'] as 50 | 200,
    concurrency: value['concurrency'] as 1 | 4 | 8,
  };
}
function frozenShape(value: unknown): FrozenCandidateDataset | null {
  if (
    !isObject(value) ||
    !exactKeys(value, [
      'dataset',
      'provenance',
      'batch',
      'materials',
      'firstPages',
    ]) ||
    (value['dataset'] !== 'AUTHENTICATED-REAL' &&
      value['dataset'] !== 'SYNTHETIC-S10') ||
    !isObject(value['provenance']) ||
    !exactKeys(value['provenance'], [
      'kind',
      'receiptSha256',
      'inventorySha256',
    ]) ||
    value['provenance']['kind'] !== 'standard-intake-http' ||
    !digestValid(value['provenance']['receiptSha256']) ||
    !digestValid(value['provenance']['inventorySha256'])
  )
    return null;
  const batch = IngestionCandidateBatchSchema.safeParse(value['batch']);
  if (!batch.success) return null;
  const materials = value['materials'],
    firstPages = value['firstPages'];
  if (
    !Array.isArray(materials) ||
    materials.length === 0 ||
    materials.length > 10_000 ||
    !Array.isArray(firstPages) ||
    firstPages.length < 6 ||
    firstPages.length > 40_002
  )
    return null;
  for (const material of materials as unknown[]) {
    if (
      !isObject(material) ||
      !exactKeys(material, [
        'assetId',
        'columns',
        'recordsDigest',
        'geometryDigest',
      ]) ||
      !PlatformUuidSchema.safeParse(material['assetId']).success ||
      !digestValid(material['recordsDigest']) ||
      !digestValid(material['geometryDigest']) ||
      !IngestionCandidateRecordPageSchema.shape.columns.safeParse(
        material['columns'],
      ).success
    )
      return null;
  }
  for (const page of firstPages as unknown[]) {
    if (
      !isObject(page) ||
      !exactKeys(page, ['action', 'first', 'assetId', 'digest']) ||
      (page['action'] !== 'get' &&
        page['action'] !== 'records' &&
        page['action'] !== 'geometry') ||
      (page['first'] !== 50 && page['first'] !== 200) ||
      (page['assetId'] !== null &&
        !PlatformUuidSchema.safeParse(page['assetId']).success) ||
      !digestValid(page['digest'])
    )
      return null;
  }
  return {
    dataset: value['dataset'],
    provenance: {
      kind: 'standard-intake-http',
      receiptSha256: value['provenance']['receiptSha256'],
      inventorySha256: value['provenance']['inventorySha256'],
    },
    batch: batch.data,
    materials: materials.map((item: MaterialInventory) => ({
      assetId: item.assetId,
      columns: item.columns.map((column) => ({
        key: column.key,
        label: column.label,
      })),
      recordsDigest: item.recordsDigest,
      geometryDigest: item.geometryDigest,
    })),
    firstPages: firstPages.map(
      (item: FrozenCandidateDataset['firstPages'][number]) => ({
        action: item.action,
        first: item.first,
        assetId: item.assetId,
        digest: item.digest,
      }),
    ),
  };
}
const canonical = (id: string) => id.toLowerCase();

export class CandidateLoadTransportError extends Error {
  readonly kind: LoadFailure;
  constructor(kind: LoadFailure) {
    super('Candidate measurement could not complete');
    this.kind = [
      'denied',
      'stale',
      'invalid',
      'unavailable',
      'cancelled',
      'drift',
      'instrumentation',
    ].includes(kind)
      ? kind
      : 'unavailable';
    Object.defineProperty(this, 'kind', {
      writable: false,
      configurable: false,
    });
  }
}

/** A transport gets a copy it cannot use to relabel this fixed measurement. */
export function immutableLoadRequest(request: LoadRequest): LoadRequest {
  return Object.freeze({
    ...request,
    reference: Object.freeze({ ...request.reference }),
  });
}

export function candidateLoadConditions(dataset: LoadDataset): LoadCondition[] {
  return (['get', 'records', 'geometry'] as const).flatMap((action) =>
    ([50, 200] as const).flatMap((first) =>
      ([1, 4, 8] as const).map((concurrency) => ({
        dataset,
        action,
        first,
        concurrency,
      })),
    ),
  );
}

export function readFrozenCandidateInput(value: unknown): FrozenInputResult {
  let parsed: FrozenCandidateDataset | null;
  try {
    parsed = frozenShape(value);
  } catch {
    return { status: 'not_run', reason: 'incomplete_inventory' };
  }
  if (parsed === null)
    return { status: 'not_run', reason: 'incomplete_inventory' };
  const input = parsed;
  const ids = input.batch.assets.map((asset) => canonical(asset.assetId));
  const materialIds = input.materials.map((material) =>
    canonical(material.assetId),
  );
  const identitySet = new Set(ids);
  const expected = new Set(['get/50/', 'get/200/']);
  for (const id of ids) {
    for (const action of ['records', 'geometry']) {
      for (const first of [50, 200]) expected.add(`${action}/${first}/${id}`);
    }
  }
  const pageKeys = input.firstPages.map(
    (page) =>
      `${page.action}/${page.first}/${page.assetId === null ? '' : canonical(page.assetId)}`,
  );
  if (
    input.batch.status !== 'READY' ||
    input.batch.assets.some(
      (asset) =>
        !['READY', 'EMPTY'].includes(asset.status) ||
        asset.recordCount === null ||
        asset.featureCount === null,
    ) ||
    identitySet.size !== ids.length ||
    materialIds.length !== ids.length ||
    new Set(materialIds).size !== ids.length ||
    materialIds.some((id) => !identitySet.has(id)) ||
    input.materials.some(
      (material) =>
        new Set(material.columns.map((column) => column.key)).size !==
        material.columns.length,
    ) ||
    pageKeys.length !== expected.size ||
    new Set(pageKeys).size !== expected.size ||
    pageKeys.some((key) => !expected.has(key))
  )
    return { status: 'not_run', reason: 'incomplete_inventory' };
  return { status: 'ready', input };
}

/** Strict page validation, shared with full traversal; no raw diagnostics escape. */
export function validateLoadReply(
  frozen: FrozenCandidateDataset,
  request: LoadRequest,
  reply: LoadReply,
): ValidatedReply {
  const fail = (failure: LoadFailure): ValidatedReply => ({
    ok: false,
    failure,
  });
  if (reply.boundary !== 'api-http' || request.method !== 'GET')
    return fail('invalid');
  if (reply.status !== 200) {
    return fail(
      reply.status === 401 || reply.status === 403
        ? 'denied'
        : [404, 409, 410].includes(reply.status)
          ? 'stale'
          : [413, 415, 422].includes(reply.status)
            ? 'invalid'
            : 'unavailable',
    );
  }
  const input = (
    request.action === 'get'
      ? IngestionCandidateReadInputSchema
      : IngestionCandidateRecordsInputSchema
  ).safeParse({
    ...request.reference,
    first: request.first,
    ...(request.after === undefined ? {} : { after: request.after }),
    ...(request.assetId === undefined ? {} : { assetId: request.assetId }),
  });
  if (
    !input.success ||
    !/^application\/json(?:\s*;|$)/i.test(reply.contentType) ||
    !Number.isSafeInteger(reply.wireBytes) ||
    reply.wireBytes < 0 ||
    reply.wireBytes > LOAD_PAGE_BYTES ||
    candidateSavedReferenceKey(request.reference) !==
      candidateSavedReferenceKey(frozen.batch.reference)
  )
    return fail('invalid');
  const schema = {
    get: IngestionCandidateAssetPageSchema,
    records: IngestionCandidateRecordPageSchema,
    geometry: IngestionCandidateGeometryPageSchema,
  }[request.action];
  const parsed = schema.safeParse(reply.body);
  if (!parsed.success) return fail('invalid');
  const page = parsed.data;
  const items =
    'assets' in page
      ? page.assets
      : 'records' in page
        ? page.records
        : page.features;
  if (
    candidateSavedReferenceKey(page.reference) !==
      candidateSavedReferenceKey(request.reference) ||
    items.length > request.first ||
    (items.length === 0 && page.nextCursor !== null) ||
    (page.nextCursor !== null &&
      (page.nextCursor.length > 2048 || page.nextCursor === request.after)) ||
    ('assetId' in page &&
      (request.assetId === undefined ||
        canonical(page.assetId) !== canonical(request.assetId)))
  )
    return fail('invalid');
  const dtoBytes = jsonUtf8Bytes(page);
  if (dtoBytes > LOAD_PAGE_BYTES) return fail('invalid');
  if ('assets' in page) {
    const recordCount = frozen.batch.assets.reduce(
      (sum, asset) => sum + (asset.recordCount ?? 0),
      0,
    );
    const featureCount = frozen.batch.assets.reduce(
      (sum, asset) => sum + (asset.featureCount ?? 0),
      0,
    );
    if (
      page.status !== 'READY' ||
      page.unknownAssetCount !== 0 ||
      page.parserVersion !== frozen.batch.parserVersion ||
      page.createdAt !== frozen.batch.createdAt ||
      page.totalAssetCount !== frozen.batch.assets.length ||
      page.knownRecordCount !== recordCount ||
      page.knownFeatureCount !== featureCount ||
      page.assets.some((asset) => {
        const original = frozen.batch.assets.find(
          (item) => canonical(item.assetId) === canonical(asset.assetId),
        );
        return (
          original === undefined ||
          asset.status !== original.status ||
          asset.sourceHash !== original.sourceHash ||
          asset.recordCount !== original.recordCount ||
          asset.featureCount !== original.featureCount ||
          asset.reason !== original.reason
        );
      })
    )
      return fail('drift');
  } else {
    const original = frozen.batch.assets.find(
      (asset) => canonical(asset.assetId) === canonical(page.assetId),
    );
    const material = frozen.materials.find(
      (item) => canonical(item.assetId) === canonical(page.assetId),
    );
    if (
      original === undefined ||
      material === undefined ||
      ('records' in page &&
        (page.records.length > (original.recordCount ?? 0) ||
          JSON.stringify(page.columns) !== JSON.stringify(material.columns))) ||
      ('features' in page &&
        page.features.length > (original.featureCount ?? 0))
    )
      return fail('drift');
  }
  return { ok: true, page, dtoBytes };
}

export function pageFingerprint(
  page: LoadPage,
  fingerprint: LoadPorts['fingerprint'],
): string {
  const { nextCursor: _cursor, ...content } = page;
  return fingerprint(canonicalLoadContent(content));
}

/** Object key order is immaterial; columns, rows, arrays and missing values are not. */
export function canonicalLoadContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalLoadContent);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalLoadContent(value[key])]),
    );
  }
  return value;
}

export function summarizeCandidateSamples(
  samples: readonly LoadSample[],
): LoadStatistics {
  const validTime = (sample: LoadSample) =>
    sample.elapsedMs !== null &&
    Number.isFinite(sample.elapsedMs) &&
    sample.elapsedMs >= 0;
  const times = samples
    .filter(validTime)
    .map((sample) => sample.elapsedMs as number)
    .sort((a, b) => a - b);
  const completed = samples.filter(
    (sample) => sample.outcome === 'completed' && validTime(sample),
  ).length;
  const failed = samples.length - completed;
  const medianMs = times[Math.floor(times.length / 2)] ?? null;
  const p95Ms = times[Math.ceil(times.length * 0.95) - 1] ?? null;
  const ordinals = new Set(samples.map((sample) => sample.ordinal));
  const protocolComplete =
    completed === 100 &&
    failed === 0 &&
    samples.length === 100 &&
    ordinals.size === 100 &&
    samples.every(
      (sample) =>
        Number.isInteger(sample.ordinal) &&
        sample.ordinal >= 1 &&
        sample.ordinal <= 100,
    );
  return {
    completed,
    failed,
    medianMs,
    p95Ms,
    meetsLatencyTarget:
      protocolComplete &&
      medianMs !== null &&
      p95Ms !== null &&
      medianMs <= 300 &&
      p95Ms <= 800,
  };
}

export async function runCandidateLoadCondition(
  value: unknown,
  requestedCondition: LoadCondition,
  ports: LoadPorts,
): Promise<LoadConditionResult> {
  const admitted = readFrozenCandidateInput(value);
  const checkedCondition = loadCondition(requestedCondition);
  const condition: LoadCondition =
    checkedCondition !== null
      ? checkedCondition
      : { dataset: 'SYNTHETIC-S10', action: 'get', first: 50, concurrency: 1 };
  const empty = (
    reason: 'incomplete_inventory' | 'condition_invalid',
  ): LoadConditionResult => ({
    condition,
    status: 'not_run',
    reason,
    warmup: [],
    measured: [],
    statistics: summarizeCandidateSamples([]),
  });
  if (checkedCondition === null) return empty('condition_invalid');
  if (admitted.status !== 'ready') return empty('incomplete_inventory');
  const frozen = admitted.input;
  if (condition.dataset !== frozen.dataset) return empty('condition_invalid');
  const asset =
    condition.action === 'get'
      ? undefined
      : (frozen.batch.assets.find((item) =>
          condition.action === 'records'
            ? (item.recordCount ?? 0) > 0
            : (item.featureCount ?? 0) > 0,
        ) ?? frozen.batch.assets[0]);
  const request = immutableLoadRequest({
    method: 'GET',
    action: condition.action,
    reference: frozen.batch.reference,
    first: condition.first,
    ...(asset === undefined ? {} : { assetId: asset.assetId }),
  });
  const frozenPage = frozen.firstPages.find(
    (item) =>
      item.action === condition.action &&
      item.first === condition.first &&
      (item.assetId === null
        ? asset === undefined
        : asset !== undefined &&
          canonical(item.assetId) === canonical(asset.assetId)),
  );
  if (frozenPage === undefined) return empty('incomplete_inventory');
  let stop = false;
  const timed = async (ordinal: number): Promise<LoadSample> => {
    let started: number | null = null,
      wireBytes: number | null = null,
      dtoBytes: number | null = null;
    let outcome: LoadSample['outcome'] = 'unavailable';
    try {
      started = ports.now();
      if (!Number.isFinite(started))
        throw new CandidateLoadTransportError('instrumentation');
      const response = await ports.send(request);
      wireBytes =
        Number.isSafeInteger(response.wireBytes) && response.wireBytes >= 0
          ? response.wireBytes
          : null;
      const checked = validateLoadReply(frozen, request, response);
      if (!checked.ok) outcome = checked.failure;
      else {
        dtoBytes = checked.dtoBytes;
        outcome =
          pageFingerprint(checked.page, ports.fingerprint) === frozenPage.digest
            ? 'completed'
            : 'drift';
      }
    } catch (error) {
      outcome =
        error instanceof CandidateLoadTransportError
          ? error.kind
          : 'unavailable';
    }
    let elapsedMs: number | null = null;
    try {
      const ended = ports.now();
      if (
        started !== null &&
        Number.isFinite(started) &&
        Number.isFinite(ended) &&
        ended >= started
      )
        elapsedMs = ended - started;
      else outcome = 'instrumentation';
    } catch {
      outcome = 'instrumentation';
    }
    if (
      ['denied', 'stale', 'drift', 'cancelled', 'instrumentation'].includes(
        outcome,
      )
    )
      stop = true;
    return { ordinal, elapsedMs, outcome, wireBytes, dtoBytes };
  };
  const phase = async (count: number): Promise<LoadSample[]> => {
    let next = 0;
    const samples: LoadSample[] = [];
    await Promise.all(
      Array.from(
        { length: Math.min(condition.concurrency, count) },
        async () => {
          while (!stop && next < count) {
            const index = next++;
            samples[index] = await timed(index + 1);
          }
        },
      ),
    );
    return samples;
  };
  const warmup = await phase(5);
  if (
    warmup.length !== 5 ||
    warmup.some((sample) => sample.outcome !== 'completed')
  ) {
    return {
      condition,
      status: 'failed',
      reason: null,
      warmup,
      measured: [],
      statistics: summarizeCandidateSamples([]),
    };
  }
  const measured = await phase(100);
  const statistics = summarizeCandidateSamples(measured);
  return {
    condition,
    status: statistics.meetsLatencyTarget ? 'passed' : 'failed',
    reason: null,
    warmup,
    measured,
    statistics,
  };
}
