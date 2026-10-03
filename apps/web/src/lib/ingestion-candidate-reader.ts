import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateRecordPageSchema,
  IngestionCandidateGeometryPageSchema,
  IngestionCandidateReadInputSchema,
  IngestionCandidateRecordsInputSchema,
  IngestionCandidateReferenceSchema,
  candidateSavedReferenceKey,
  CreateIngestionCandidateViewInputSchema,
  CreateIngestionCandidateViewOutputSchema,
  ListIngestionCandidateViewsInputSchema,
  ListIngestionCandidateViewsOutputSchema,
  OpenIngestionCandidateViewInputSchema,
  OpenIngestionCandidateViewOutputSchema,
  RevokeIngestionCandidateViewInputSchema,
  RevokeIngestionCandidateViewOutputSchema,
  type IngestionCandidateGeometry,
  type IngestionCandidateGeometryPage,
  type IngestionCandidateAssetPage,
  type IngestionCandidateRecordPage,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';

export type CandidateReadAction = 'get' | 'records' | 'geometry';
export interface CandidatePages {
  get: IngestionCandidateAssetPage;
  records: IngestionCandidateRecordPage;
  geometry: IngestionCandidateGeometryPage;
}
export class CandidateReaderError extends Error {
  constructor(
    readonly kind: 'denied' | 'stale' | 'invalid' | 'unavailable' | 'cancelled',
  ) {
    super('Candidate content is unavailable');
  }
}
const PAGE_BYTES = 3 * 1024 * 1024;

function current(signal: AbortSignal) {
  if (signal.aborted) throw new CandidateReaderError('cancelled');
}
async function jsonBody(
  response: Response,
  signal: AbortSignal,
  maximum = PAGE_BYTES,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new CandidateReaderError('invalid');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body.cancel().catch(() => {});
    throw new CandidateReaderError('invalid');
  }
  const reader = response.body.getReader();
  let rejectAbort!: (error: CandidateReaderError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    void reader.cancel().catch(() => {});
    rejectAbort(new CandidateReaderError('cancelled'));
  };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    current(signal);
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      current(signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new CandidateReaderError('invalid');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('invalid');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Client reads only the current same-origin, server-authorized fixed page. */
export async function readCandidatePage<A extends CandidateReadAction>(
  action: A,
  input: unknown,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidatePages[A]> {
  current(signal);
  const request = (
    action === 'get'
      ? IngestionCandidateReadInputSchema
      : IngestionCandidateRecordsInputSchema
  ).safeParse(input);
  if (!request.success) throw new CandidateReaderError('invalid');
  try {
    const response = await fetch(`/api/data-foundation/candidates/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.data),
      cache: 'no-store',
      signal,
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError('cancelled');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError(
        response.status === 401 || response.status === 403
          ? 'denied'
          : [404, 409, 410].includes(response.status)
            ? 'stale'
            : [413, 415, 422].includes(response.status)
              ? 'invalid'
              : 'unavailable',
      );
    }
    const body = await jsonBody(response, signal);
    const schema = {
      get: IngestionCandidateAssetPageSchema,
      records: IngestionCandidateRecordPageSchema,
      geometry: IngestionCandidateGeometryPageSchema,
    }[action];
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new CandidateReaderError('invalid');
    const value = parsed.data;
    const items =
      'assets' in value
        ? value.assets
        : 'records' in value
          ? value.records
          : value.features;
    const requestedAsset =
      'assetId' in request.data && typeof request.data.assetId === 'string'
        ? request.data.assetId
        : null;
    if (
      candidateSavedReferenceKey(value.reference) !==
        candidateSavedReferenceKey(request.data) ||
      items.length > request.data.first ||
      (items.length === 0 && value.nextCursor !== null) ||
      ('assetId' in value &&
        (requestedAsset === null ||
          value.assetId.toLowerCase() !== requestedAsset.toLowerCase())) ||
      (value.nextCursor !== null &&
        (value.nextCursor.length > 2048 ||
          value.nextCursor === request.data.after))
    ) {
      throw new CandidateReaderError('invalid');
    }
    current(signal);
    return value as CandidatePages[A];
  } catch (error) {
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('unavailable');
  }
}
export function candidateOriginalUrl(
  reference: IngestionCandidateReference,
  assetId: string,
  locale: string,
): string {
  const ref = IngestionCandidateReferenceSchema.parse(reference);
  const asset = PlatformUuidSchema.parse(assetId);
  if (locale !== 'zh-CN' && locale !== 'en')
    throw new CandidateReaderError('invalid');
  return `/api/data-foundation/candidate-assets/${ref.ingestionId.toLowerCase()}/${ref.processingBatchId.toLowerCase()}/${asset.toLowerCase()}?reviewHash=${ref.reviewHash}&locale=${locale}`;
}

export interface CandidateDisplayFeatures {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly id: string;
    readonly geometry: {
      readonly type: Exclude<
        IngestionCandidateGeometry['type'],
        'GeometryCollection'
      >;
      readonly coordinates: unknown;
    };
    readonly properties: Readonly<Record<string, unknown>>;
  }[];
}
/** Collections become drawing parts; candidate identity and original geometry stay intact. */
export function candidateMapFeatures(
  page: IngestionCandidateGeometryPage,
): CandidateDisplayFeatures {
  const validated = IngestionCandidateGeometryPageSchema.parse(page);
  const features: CandidateDisplayFeatures['features'][number][] = [];
  for (const feature of validated.features) {
    const draw = (geometry: IngestionCandidateGeometry, path: string) => {
      if (geometry.type === 'GeometryCollection') {
        for (const [index, child] of (geometry.geometries ?? []).entries())
          draw(child, `${path}.${index}`);
      } else
        features.push({
          type: 'Feature',
          id: `${feature.recordId}:${path}`,
          geometry: { type: geometry.type, coordinates: geometry.coordinates },
          properties: {
            recordId: feature.recordId,
            assetId: feature.assetId,
            sourceId: feature.sourceId,
          },
        });
    };
    // The shared schema has checked the nested JSON geometry before this typed traversal.
    draw(feature.geometry as IngestionCandidateGeometry, '0');
  }
  return { type: 'FeatureCollection', features };
}

export interface CandidateSavedPages {
  create: ReturnType<typeof CreateIngestionCandidateViewOutputSchema.parse>;
  list: ReturnType<typeof ListIngestionCandidateViewsOutputSchema.parse>;
  open: ReturnType<typeof OpenIngestionCandidateViewOutputSchema.parse>;
  revoke: ReturnType<typeof RevokeIngestionCandidateViewOutputSchema.parse>;
}
export async function readCandidateSavedView<
  A extends keyof CandidateSavedPages,
>(
  action: A,
  input: unknown,
  signal: AbortSignal,
  idempotencyKey?: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidateSavedPages[A]> {
  current(signal);
  const schemas = {
    create: [
      CreateIngestionCandidateViewInputSchema,
      CreateIngestionCandidateViewOutputSchema,
    ],
    list: [
      ListIngestionCandidateViewsInputSchema,
      ListIngestionCandidateViewsOutputSchema,
    ],
    open: [
      OpenIngestionCandidateViewInputSchema,
      OpenIngestionCandidateViewOutputSchema,
    ],
    revoke: [
      RevokeIngestionCandidateViewInputSchema,
      RevokeIngestionCandidateViewOutputSchema,
    ],
  } as const;
  const selected = schemas[action];
  const request = selected[0].safeParse(input);
  if (
    !request.success ||
    ((action === 'create' || action === 'revoke') &&
      !PlatformUuidSchema.safeParse(idempotencyKey).success)
  )
    throw new CandidateReaderError('invalid');
  try {
    const body = JSON.stringify(request.data);
    if (new TextEncoder().encode(body).byteLength > 128 * 1024)
      throw new CandidateReaderError('invalid');
    const response = await fetch(
      `/api/data-foundation/candidate-saved-views/${action}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body,
        cache: 'no-store',
        signal,
      },
    );
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError('cancelled');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError(
        response.status === 401 || response.status === 403
          ? 'denied'
          : [404, 409, 410].includes(response.status)
            ? 'stale'
            : [413, 415, 422].includes(response.status)
              ? 'invalid'
              : 'unavailable',
      );
    }
    const parsed = selected[1].safeParse(
      await jsonBody(response, signal, 128 * 1024),
    );
    if (!parsed.success) throw new CandidateReaderError('invalid');
    const value = parsed.data;
    if (
      ('viewId' in request.data &&
        typeof request.data.viewId === 'string' &&
        ('savedView' in value
          ? value.savedView.viewId.toLowerCase()
          : 'viewId' in value
            ? value.viewId.toLowerCase()
            : '') !== request.data.viewId.toLowerCase()) ||
      ('items' in value &&
        (!('first' in request.data) ||
          typeof request.data.first !== 'number' ||
          value.items.length > request.data.first ||
          value.items.some((view) => view.revokedAt !== null) ||
          new Set(value.items.map((view) => view.viewId.toLowerCase())).size !==
            value.items.length ||
          (value.nextCursor !== null &&
            'after' in request.data &&
            value.nextCursor === request.data.after)))
    )
      throw new CandidateReaderError('invalid');
    current(signal);
    return value as CandidateSavedPages[A];
  } catch (error) {
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('unavailable');
  }
}
