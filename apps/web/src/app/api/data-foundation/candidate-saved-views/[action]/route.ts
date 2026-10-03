import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import { isSameOriginRequest } from '@/lib/request-origin';

const headers = { 'cache-control': 'private, no-store' };
const fail = (status: number, code = 'CANDIDATE_VIEW_FAILED') =>
  Response.json({ code }, { status, headers });

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await context.params;
  if (
    action !== 'create' &&
    action !== 'list' &&
    action !== 'open' &&
    action !== 'revoke'
  )
    return fail(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return fail(403, 'FORBIDDEN');
  const reader = request.body?.getReader();
  if (!reader) return fail(422, 'INVALID_QUERY');
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    request.signal.throwIfAborted();
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const part = await reader.read();
      request.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) {
        void reader.cancel().catch(() => {});
        return fail(413, 'INVALID_QUERY');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      return fail(422, 'INVALID_QUERY');
    }
    request.signal.throwIfAborted();
    const dal = await getDataFoundationDal();
    request.signal.throwIfAborted();
    const page = await dal.candidateSavedView(
      action,
      input,
      request.headers.get('Idempotency-Key') ?? undefined,
      request.signal,
    );
    request.signal.throwIfAborted();
    return Response.json(page, { headers });
  } catch (error) {
    if (request.signal.aborted) abort();
    return fail(
      request.signal.aborted
        ? 499
        : error instanceof DataFoundationApiError
          ? error.status
          : 503,
    );
  } finally {
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
