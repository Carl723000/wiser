import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import { parseDataRouteUuid } from '@/lib/data-foundation';
import { isSameOriginRequest } from '@/lib/request-origin';

const headers = { 'cache-control': 'private, no-store' };
const fail = (status: number) =>
  Response.json({ code: 'OPERATION_EVENTS_FAILED' }, { status, headers });

/** Internal POST transport keeps authority-bound cursors out of browser URLs. */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return fail(403);
  const reader = request.body?.getReader();
  if (!reader) return fail(422);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 10_000);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      void reader.cancel().catch(() => {});
      reject(
        new DataFoundationApiError(
          'unavailable',
          request.signal.aborted ? 499 : 504,
        ),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const work = async () => {
      signal.throwIfAborted();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 16_384) {
          void reader.cancel().catch(() => {});
          return fail(413);
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let input: unknown;
      try {
        input = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch {
        return fail(422);
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        return fail(422);
      const row = input as Record<string, unknown>;
      if (
        Object.keys(row).some((key) => key !== 'operationId' && key !== 'after')
      )
        return fail(422);
      const operationId =
        typeof row.operationId === 'string'
          ? parseDataRouteUuid(row.operationId)
          : null;
      if (
        operationId === null ||
        (row.after !== undefined &&
          (typeof row.after !== 'string' ||
            row.after.length < 1 ||
            row.after.length > 2048))
      )
        return fail(422);
      signal.throwIfAborted();
      const dal = await getDataFoundationDal();
      signal.throwIfAborted();
      const page = await dal.operationEvents(
        operationId,
        row.after as string | undefined,
        signal,
      );
      signal.throwIfAborted();
      return Response.json(page, { headers });
    };
    return await Promise.race([work(), aborted]);
  } catch (error) {
    return fail(
      request.signal.aborted
        ? 499
        : deadline.signal.aborted
          ? 504
          : error instanceof DataFoundationApiError
            ? error.status
            : 503,
    );
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
