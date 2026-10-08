import {
  DATA_CAPABILITY_REGISTRY,
  candidateSavedReferenceKey,
} from '@wiser/data-contracts';
import { canonicalCandidateFollowupEvidence } from '@wiser/data-core/candidate-followups';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import type {
  CandidateFollowupOutputSchema,
  ListCandidateFollowupsOutputSchema,
} from '@wiser/data-contracts/candidate-followups';
import { CandidateReaderError } from './ingestion-candidate-reader';
export type CandidateFollowupAction =
  'create' | 'get' | 'list' | 'act' | 'review';
export type FollowupOutput = ReturnType<
  typeof CandidateFollowupOutputSchema.parse
>;
export type FollowupList = ReturnType<
  typeof ListCandidateFollowupsOutputSchema.parse
>;
export interface CandidateFollowupPages {
  create: FollowupOutput;
  get: FollowupOutput;
  list: FollowupList;
  act: FollowupOutput;
  review: FollowupOutput;
}
function current(signal: AbortSignal) {
  if (signal.aborted) throw new CandidateReaderError('cancelled');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export function sameCandidateFollowupEvidence(a: unknown, b: unknown) {
  return (
    canonical(canonicalCandidateFollowupEvidence(a)) ===
    canonical(canonicalCandidateFollowupEvidence(b))
  );
}
async function jsonBody(
  response: Response,
  signal: AbortSignal,
  maximum = 2 * 1024 * 1024,
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

export function parseCandidateFollowupOutput<A extends CandidateFollowupAction>(
  action: A,
  input: unknown,
  body: unknown,
): CandidateFollowupPages[A] {
  const capability =
    DATA_CAPABILITY_REGISTRY[`data.ingestion.candidate.followup.${action}`];
  const request = capability.inputSchema.parse(input) as Record<
    string,
    unknown
  >;
  const output = capability.outputSchema.parse(body) as
    FollowupOutput | FollowupList;
  if ('items' in output) {
    const key = candidateSavedReferenceKey(
      request as Parameters<typeof candidateSavedReferenceKey>[0],
    );
    if (
      output.items.length > Number(request['first']) ||
      (output.items.length === 0 && output.nextCursor !== null) ||
      (output.nextCursor !== null && output.nextCursor === request['after']) ||
      new Set(output.items.map((x) => x.followupId.toLowerCase())).size !==
        output.items.length ||
      output.items.some(
        (x) =>
          candidateSavedReferenceKey(x.source.reference) !== key ||
          (request['state'] !== undefined && x.state !== request['state']),
      )
    )
      throw new CandidateReaderError('invalid');
  } else if (action === 'create') {
    const f = output.followup;
    if (
      f.type !== request['type'] ||
      f.ruleId !== request['ruleId'] ||
      f.ruleVersion !== request['ruleVersion'] ||
      f.reason !== request['reason'] ||
      !sameCandidateFollowupEvidence(f.source, request['source'])
    )
      throw new CandidateReaderError('invalid');
  } else if (
    typeof request['followupId'] !== 'string' ||
    output.followup.followupId.toLowerCase() !==
      request['followupId'].toLowerCase()
  )
    throw new CandidateReaderError('invalid');
  return output as CandidateFollowupPages[A];
}
export async function readCandidateFollowup<A extends CandidateFollowupAction>(
  action: A,
  input: unknown,
  signal: AbortSignal,
  idempotencyKey?: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CandidateFollowupPages[A]> {
  current(signal);
  if (!['create', 'get', 'list', 'act', 'review'].includes(action))
    throw new CandidateReaderError('invalid');
  const request =
    DATA_CAPABILITY_REGISTRY[
      `data.ingestion.candidate.followup.${action}`
    ].inputSchema.safeParse(input);
  const command =
    action === 'create' || action === 'act' || action === 'review';
  if (
    !request.success ||
    (command && !PlatformUuidSchema.safeParse(idempotencyKey).success)
  )
    throw new CandidateReaderError('invalid');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 15000);
  const active = AbortSignal.any([signal, timeout.signal]);
  try {
    const response = await fetch(
      `/api/data-foundation/candidate-followups/${action}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(command ? { 'Idempotency-Key': idempotencyKey! } : {}),
        },
        body: JSON.stringify(request.data),
        cache: 'no-store',
        signal: active,
      },
    ).catch(() => {
      throw new CandidateReaderError('unavailable');
    });
    if (active.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new CandidateReaderError(
        signal.aborted ? 'cancelled' : 'unavailable',
      );
    }
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
    const output = parseCandidateFollowupOutput(
      action,
      request.data,
      await jsonBody(response, active),
    );
    current(signal);
    return output;
  } catch (error) {
    if (signal.aborted) throw new CandidateReaderError('cancelled');
    if (timeout.signal.aborted) throw new CandidateReaderError('unavailable');
    if (error instanceof CandidateReaderError) throw error;
    throw new CandidateReaderError('invalid');
  } finally {
    clearTimeout(timer);
  }
}
