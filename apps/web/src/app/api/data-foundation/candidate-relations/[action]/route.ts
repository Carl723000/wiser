import {
  GetCandidateRelationInputSchema,
  ListCandidateRelationsInputSchema,
} from '@wiser/data-contracts';
import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';
import { isSameOriginRequest } from '@/lib/request-origin';
import {
  CANDIDATE_RELATION_INPUT_BYTES,
  CANDIDATE_RELATION_OUTPUT_BYTES,
  parseCandidateRelationOutput,
} from '@/lib/candidate-relation-reader';
const headers = { 'cache-control': 'private, no-store' };
const fail = (status: number, code = 'CANDIDATE_RELATION_FAILED') =>
  Response.json({ code }, { status, headers });
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await context.params;
  if (action !== 'get' && action !== 'list') return fail(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return fail(403, 'FORBIDDEN');
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get('content-type') ?? '',
    )
  )
    return fail(415, 'INVALID_QUERY');
  const reader = request.body?.getReader();
  if (!reader) return fail(422, 'INVALID_QUERY');
  const deadline = new AbortController();
  const active = AbortSignal.any([request.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 30000);
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  active.addEventListener('abort', cancel, { once: true });
  try {
    active.throwIfAborted();
    let size = 0,
      text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for (;;) {
        const part = await untilAbort(reader.read(), active);
        active.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > CANDIDATE_RELATION_INPUT_BYTES) {
          cancel();
          return fail(413, 'INVALID_QUERY');
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (active.aborted) throw error;
      cancel();
      return fail(422, 'INVALID_QUERY');
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return fail(422, 'INVALID_QUERY');
    }
    const parsed = (
      action === 'get'
        ? GetCandidateRelationInputSchema
        : ListCandidateRelationsInputSchema
    ).safeParse(input);
    if (!parsed.success) return fail(422, 'INVALID_QUERY');
    active.throwIfAborted();
    const dal = await untilAbort(getDataFoundationDal(), active);
    active.throwIfAborted();
    const output = await untilAbort<unknown>(
      action === 'get'
        ? dal.candidateRelationGet(parsed.data, active)
        : dal.candidateRelationList(parsed.data, active),
      active,
    );
    active.throwIfAborted();
    try {
      const value = parseCandidateRelationOutput(action, parsed.data, output);
      const json = JSON.stringify(value);
      if (
        new TextEncoder().encode(json).byteLength >
        CANDIDATE_RELATION_OUTPUT_BYTES
      )
        return fail(502);
      return new Response(json, {
        headers: { ...headers, 'content-type': 'application/json' },
      });
    } catch {
      return fail(502);
    }
  } catch (error) {
    if (active.aborted) cancel();
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
    active.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
