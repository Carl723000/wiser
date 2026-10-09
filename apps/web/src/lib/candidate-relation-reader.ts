import {
  GetCandidateRelationInputSchema,
  GetCandidateRelationOutputSchema,
  ListCandidateRelationsInputSchema,
  ListCandidateRelationsOutputSchema,
  candidateSavedReferenceKey,
} from '@wiser/data-contracts';
import { CandidateReaderError } from './ingestion-candidate-reader';

export type CandidateRelationAction = 'get' | 'list';
export interface CandidateRelationPages {
  get: ReturnType<typeof GetCandidateRelationOutputSchema.parse>;
  list: ReturnType<typeof ListCandidateRelationsOutputSchema.parse>;
}
export const CANDIDATE_RELATION_INPUT_BYTES = 64 * 1024;
export const CANDIDATE_RELATION_OUTPUT_BYTES = 1024 * 1024;
const inputSchemas = {
  get: GetCandidateRelationInputSchema,
  list: ListCandidateRelationsInputSchema,
};
const outputSchemas = {
  get: GetCandidateRelationOutputSchema,
  list: ListCandidateRelationsOutputSchema,
};
const current = (signal: AbortSignal) => {
  if (signal.aborted) throw new CandidateReaderError('cancelled');
};

/** Validate the existing public read contract; this grants no source authority. */
export function parseCandidateRelationOutput<A extends CandidateRelationAction>(
  action: A,
  input: unknown,
  body: unknown,
): CandidateRelationPages[A] {
  if (action !== 'get' && action !== 'list')
    throw new CandidateReaderError('invalid');
  const request = inputSchemas[action].safeParse(input);
  const response = outputSchemas[action].safeParse(body);
  if (!request.success || !response.success)
    throw new CandidateReaderError('invalid');
  const allowed = new Set(
    request.data.references.map(candidateSavedReferenceKey),
  );
  const output = response.data;
  const rows = 'relations' in output ? output.relations : [output.relation];
  if (
    rows.some((row) =>
      [
        row.revision.reference,
        ...row.revision.content.evidence.map((e) => e.reference),
      ].some((ref) => !allowed.has(candidateSavedReferenceKey(ref))),
    )
  )
    throw new CandidateReaderError('invalid');
  if ('relations' in output) {
    const query = ListCandidateRelationsInputSchema.parse(request.data);
    if (
      output.relations.length > query.first ||
      (output.relations.length === 0 && output.nextCursor !== null) ||
      (output.nextCursor !== null && output.nextCursor === query.after) ||
      new Set(
        output.relations.map((row) => row.revision.relationId.toLowerCase()),
      ).size !== output.relations.length
    )
      throw new CandidateReaderError('invalid');
  } else {
    const pin = GetCandidateRelationInputSchema.parse(request.data);
    if (
      output.relation.revision.relationId.toLowerCase() !==
        pin.relationId.toLowerCase() ||
      output.relation.revision.revision !== pin.revision ||
      output.relation.decisionVersion !== pin.decisionVersion
    )
      throw new CandidateReaderError('invalid');
  }
  return output as CandidateRelationPages[A];
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new CandidateReaderError('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
async function jsonBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    (length !== null &&
      (!/^\d+$/.test(length) ||
        Number(length) > CANDIDATE_RELATION_OUTPUT_BYTES))
  ) {
    void response.body?.cancel().catch(() => {});
    throw new CandidateReaderError('invalid');
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0,
    text = '';
  try {
    current(signal);
    for (;;) {
      const part = await untilAbort(reader.read(), signal);
      current(signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CANDIDATE_RELATION_OUTPUT_BYTES)
        throw new CandidateReaderError('invalid');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    cancel();
    current(signal);
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('invalid');
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** One bounded page only. Sources and opaque cursor are never expanded. */
export async function readCandidateRelation<A extends CandidateRelationAction>(
  action: A,
  input: unknown,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidateRelationPages[A]> {
  current(signal);
  if (action !== 'get' && action !== 'list')
    throw new CandidateReaderError('invalid');
  const request = inputSchemas[action].safeParse(input);
  if (!request.success) throw new CandidateReaderError('invalid');
  const body = JSON.stringify(request.data);
  if (
    new TextEncoder().encode(body).byteLength > CANDIDATE_RELATION_INPUT_BYTES
  )
    throw new CandidateReaderError('invalid');
  const deadline = new AbortController();
  const active = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), 15000);
  let received: Response | undefined;
  try {
    const pending = fetch(
      `/api/data-foundation/candidate-relations/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        signal: active,
      },
    )
      .then((response) => {
        received = response;
        if (active.aborted) void response.body?.cancel().catch(() => {});
        return response;
      })
      .catch(() => {
        throw new CandidateReaderError('unavailable');
      });
    const response = await untilAbort(pending, active);
    current(active);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError(
        [401, 403].includes(response.status)
          ? 'denied'
          : [404, 409, 410].includes(response.status)
            ? 'stale'
            : [413, 415, 422].includes(response.status)
              ? 'invalid'
              : 'unavailable',
      );
    }
    const output = parseCandidateRelationOutput(
      action,
      request.data,
      await jsonBody(response, active),
    );
    current(active);
    return output;
  } catch (error) {
    if (active.aborted) void received?.body?.cancel().catch(() => {});
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (deadline.signal.aborted) throw new CandidateReaderError('unavailable');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('invalid');
  } finally {
    clearTimeout(timer);
  }
}
