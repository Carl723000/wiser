import 'server-only';
import {
  candidateSavedReferenceKey,
  IngestionCandidateReferenceSchema,
  type IngestionCandidateReference,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import {
  DataFoundationApiError,
  createDataFoundationDal,
  type DataFoundationWebConfig,
} from './data-foundation-dal.server';
import {
  verifiedSessionAccessToken,
  VerifiedSessionError,
  type VerifiedSessionClient,
} from './supabase/verified-session';

export interface CandidateOriginalProxyOptions {
  readonly request: Request;
  readonly ingestionId: string;
  readonly processingBatchId: string;
  readonly assetId: string;
  readonly config: DataFoundationWebConfig;
  readonly createAuthClient: () => Promise<VerifiedSessionClient | null>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const RANGE = /^bytes=(?:[0-9]{1,15}-[0-9]{0,15}|-[0-9]{1,15})$/;

function discard(body: ReadableStream<Uint8Array> | null): void {
  void body?.cancel().catch(() => undefined);
}

function abortError(request: Request): DataFoundationApiError {
  return new DataFoundationApiError(
    'unavailable',
    request.signal.aborted ? 499 : 503,
  );
}

async function within<T>(
  work: Promise<T>,
  signal: AbortSignal,
  request: Request,
): Promise<T> {
  if (signal.aborted) throw abortError(request);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError(request));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function statusError(status: number): DataFoundationApiError {
  if (status === 401) return new DataFoundationApiError('authentication', 401);
  if (status === 403) return new DataFoundationApiError('authorization', 403);
  if (status === 404) return new DataFoundationApiError('not-found', 404);
  if ([400, 409, 422].includes(status))
    return new DataFoundationApiError('invalid-request', status);
  return new DataFoundationApiError('unavailable', 503);
}

function requestedBytes(range: string | null, total: number) {
  if (range === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0
      ? { start: Math.max(0, total - suffix), end: total - 1 }
      : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  return start < total && start <= end ? { start, end } : null;
}

function declaredLength(upstream: Response, range: string | null): number {
  const raw = upstream.headers.get('content-length');
  if (!raw || !/^[1-9][0-9]{0,7}$/.test(raw))
    throw new DataFoundationApiError('contract', 502);
  const length = Number(raw);
  if (length > MAX_ORIGINAL_BYTES)
    throw new DataFoundationApiError('contract', 502);
  if (upstream.status === 206) {
    const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(
      upstream.headers.get('content-range') ?? '',
    );
    const start = Number(match?.[1]);
    const end = Number(match?.[2]);
    const total = Number(match?.[3]);
    const expected = requestedBytes(range, total);
    if (
      !match ||
      !Number.isSafeInteger(total) ||
      total < 1 ||
      total > MAX_ORIGINAL_BYTES ||
      !expected ||
      expected.start !== start ||
      expected.end !== end ||
      start > end ||
      end >= total ||
      end - start + 1 !== length
    ) {
      throw new DataFoundationApiError('contract', 502);
    }
  }
  return length;
}

function deliveryBody(
  upstream: Response,
  length: number,
  signal: AbortSignal,
  request: Request,
  authorizeSaved?: () => Promise<void>,
  cancelSaved?: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.body?.getReader();
  if (!reader) throw new DataFoundationApiError('contract', 502);
  let delivered = 0;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  };
  const stop = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', stop);
    cancelReader();
    controller.error(abortError(request));
  };
  return new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      },
      async pull(value) {
        if (finished) return;
        try {
          const chunk = await within(reader.read(), signal, request);
          if (finished) return;
          if (chunk.done) {
            if (delivered !== length)
              throw new DataFoundationApiError('contract', 502);
            finished = true;
            signal.removeEventListener('abort', stop);
            reader.releaseLock();
            value.close();
            return;
          }
          delivered += chunk.value.byteLength;
          if (delivered > length)
            throw new DataFoundationApiError('contract', 502);
          if (authorizeSaved) await authorizeSaved();
          if (finished) return;
          value.enqueue(chunk.value);
        } catch (error) {
          if (finished) return;
          finished = true;
          signal.removeEventListener('abort', stop);
          cancelReader();
          value.error(
            authorizeSaved && error instanceof DataFoundationApiError
              ? error
              : new DataFoundationApiError('contract', 502),
          );
        }
      },
      cancel() {
        finished = true;
        signal.removeEventListener('abort', stop);
        cancelSaved?.();
        cancelReader();
      },
    },
    { highWaterMark: 0 },
  );
}

/** The API verifies the full original before delivery; this hop streams without a second full buffer. */
export async function proxyCandidateOriginal(
  options: CandidateOriginalProxyOptions,
): Promise<Response> {
  const { request } = options;
  const search = new URL(request.url).searchParams;
  const reference = IngestionCandidateReferenceSchema.safeParse({
    kind: 'ingestion-candidate',
    ingestionId: options.ingestionId,
    processingBatchId: options.processingBatchId,
    reviewHash: search.get('reviewHash'),
  });
  const asset = PlatformUuidSchema.safeParse(options.assetId);
  const saved = search.has('savedViewId')
    ? PlatformUuidSchema.safeParse(search.get('savedViewId'))
    : undefined;
  const topic = search.has('savedTopicId')
    ? PlatformUuidSchema.safeParse(search.get('savedTopicId'))
    : undefined;
  const range = request.headers.get('range');
  if (
    !reference.success ||
    !asset.success ||
    (saved && !saved.success) ||
    (topic && !topic.success) ||
    (saved !== undefined && topic !== undefined) ||
    !['GET', 'HEAD'].includes(request.method) ||
    [...search.keys()].some(
      (key) =>
        !['reviewHash', 'locale', 'savedViewId', 'savedTopicId'].includes(
          key,
        ) || search.getAll(key).length !== 1,
    ) ||
    (search.has('locale') &&
      !['zh-CN', 'en'].includes(search.get('locale') ?? '')) ||
    (range !== null && !RANGE.test(range))
  ) {
    throw new DataFoundationApiError('invalid-request', 422);
  }
  const ownerId = topic?.success
    ? topic.data
    : saved?.success
      ? saved.data
      : undefined;
  const savedCancellation =
    ownerId !== undefined ? new AbortController() : undefined;
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(120_000),
    ...(savedCancellation ? [savedCancellation.signal] : []),
  ]);
  if (signal.aborted) throw abortError(request);
  const authenticate = async () => {
    try {
      return await within(
        verifiedSessionAccessToken(
          options.createAuthClient,
          options.now ?? (() => new Date()),
        ),
        signal,
        request,
      );
    } catch (error) {
      if (error instanceof VerifiedSessionError)
        throw new DataFoundationApiError(error.kind, error.status);
      if (error instanceof DataFoundationApiError) throw error;
      throw new DataFoundationApiError('authentication', 401);
    }
  };
  const token = await authenticate();
  let fixedTopic: string | undefined;
  const authorizeSaved =
    ownerId !== undefined
      ? async () => {
          // Each call performs the standard API's complete-manifest check.
          // A view ID is navigation context; it never grants original access.
          const dal = createDataFoundationDal({
            config: options.config,
            createAuthClient: options.createAuthClient,
            fetch: options.fetch,
            now: options.now,
          });
          let references: IngestionCandidateReference[];
          if (topic?.success) {
            const opened = await within(
              dal.candidateTopic(
                'open',
                { viewId: topic.data.toLowerCase() },
                signal,
              ),
              signal,
              request,
            );
            if (
              !('status' in opened) ||
              opened.status !== 'READABLE' ||
              opened.specVersion !== 2 ||
              opened.savedView.viewId.toLowerCase() !== topic.data.toLowerCase()
            )
              throw new DataFoundationApiError('not-found', 404);
            if (
              !opened.viewSpec.dependencyPins.some(
                (pin) =>
                  pin.kind === 'asset' &&
                  pin.assetId.toLowerCase() === asset.data.toLowerCase() &&
                  candidateSavedReferenceKey(pin.reference) ===
                    candidateSavedReferenceKey(reference.data),
              )
            )
              throw new DataFoundationApiError('not-found', 404);
            // Fresh resume cursors may change; the immutable topic and its full
            // manifest must remain the same for every delivered chunk.
            const binding = JSON.stringify({
              savedView: opened.savedView,
              references: opened.references,
              viewSpec: opened.viewSpec,
            });
            if (fixedTopic !== undefined && binding !== fixedTopic)
              throw new DataFoundationApiError('not-found', 404);
            fixedTopic = binding;
            references = opened.references;
          } else {
            const opened = await within(
              dal.candidateSavedView(
                'open',
                { viewId: ownerId.toLowerCase() },
                undefined,
                signal,
              ),
              signal,
              request,
            );
            if (!('references' in opened))
              throw new DataFoundationApiError('contract', 502);
            references = opened.references;
          }
          if (
            !references.some(
              (ref) =>
                candidateSavedReferenceKey(ref) ===
                candidateSavedReferenceKey(reference.data),
            )
          )
            throw new DataFoundationApiError('not-found', 404);
          if ((await authenticate()) !== token)
            throw new DataFoundationApiError('authentication', 401);
        }
      : undefined;
  if (authorizeSaved) await authorizeSaved();
  const url = new URL(
    `/api/data/v1/tenants/${options.config.tenantId}/projects/${options.config.projectId}/ingestions/${reference.data.ingestionId}/candidates/${reference.data.processingBatchId}/assets/${asset.data}/content`,
    options.config.apiOrigin,
  );
  url.searchParams.set('reviewHash', reference.data.reviewHash);
  let upstream: Response;
  try {
    const fetching = (options.fetch ?? globalThis.fetch)(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-wiser-tenant-id': options.config.tenantId,
        'x-wiser-project-id': options.config.projectId,
        'x-wiser-purpose': options.config.purpose,
        ...(range === null ? {} : { range }),
      },
      cache: 'no-store',
      redirect: 'error',
      signal,
    }).then((response) => {
      if (signal.aborted) discard(response.body);
      return response;
    });
    upstream = await within(fetching, signal, request);
  } catch (error) {
    if (error instanceof DataFoundationApiError) throw error;
    throw new DataFoundationApiError('unavailable', 503);
  }
  try {
    if (![200, 206, 416].includes(upstream.status))
      throw statusError(upstream.status);
    if ((await authenticate()) !== token)
      throw new DataFoundationApiError('authentication', 401);
    if (authorizeSaved) await authorizeSaved();
    const headers = new Headers({
      'cache-control':
        'private, no-cache, no-store, max-age=0, must-revalidate',
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "sandbox; default-src 'none'; frame-ancestors 'none'",
    });
    if (upstream.status === 416) {
      const contentRange = upstream.headers.get('content-range') ?? '';
      const match = /^bytes \*\/([0-9]+)$/.exec(contentRange);
      if (
        !match ||
        Number(match[1]) < 1 ||
        Number(match[1]) > MAX_ORIGINAL_BYTES ||
        range === null ||
        requestedBytes(range, Number(match[1])) !== null
      )
        throw new DataFoundationApiError('contract', 502);
      headers.set('content-range', contentRange);
      headers.set('content-length', '0');
      discard(upstream.body);
      return new Response(null, { status: 416, headers });
    }
    const length = declaredLength(upstream, range);
    headers.set('content-length', String(length));
    headers.set('accept-ranges', 'bytes');
    if (upstream.status === 206)
      headers.set('content-range', upstream.headers.get('content-range')!);
    if (request.method === 'HEAD') {
      discard(upstream.body);
      return new Response(null, { status: upstream.status, headers });
    }
    return new Response(
      deliveryBody(
        upstream,
        length,
        signal,
        request,
        authorizeSaved,
        savedCancellation ? () => savedCancellation.abort() : undefined,
      ),
      {
        status: upstream.status,
        headers,
      },
    );
  } catch (error) {
    discard(upstream.body);
    throw error;
  }
}
