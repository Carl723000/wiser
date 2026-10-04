import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const maxBytes = 32 * 1024 * 1024;
// Reuse the existing candidate-original operation budget, not a new public setting.
export const CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS = 120000;
export type CandidateOriginalAuditDiagnostic =
  | 'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_FAILED'
  | 'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED';

/** Observation deadlines do not cancel SQL or prove rollback/commit outcomes. */
export class CandidateOriginalAuditObserver {
  private readonly observations = new WeakMap<Promise<void>, Promise<void>>();
  private readonly pending = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly report: (
      code: CandidateOriginalAuditDiagnostic,
      attemptId: string,
    ) => void,
  ) {}

  observe(task: Promise<void>, attemptId: string): Promise<void> {
    const existing = this.observations.get(task);
    if (existing) return existing;
    let settle!: () => void;
    const observed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.observations.set(task, observed);
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code?: CandidateOriginalAuditDiagnostic) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.pending.delete(unconfirmed);
      if (code) this.report(code, attemptId);
      settle();
    };
    const unconfirmed = () =>
      finish('CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED');
    // Keep observing the underlying operation even after the caller stops waiting.
    // No connection is released, query cancelled or uncertain append retried here.
    void task.then(
      () => finish(),
      () => finish('CANDIDATE_ORIGINAL_OUTCOME_AUDIT_FAILED'),
    );
    if (this.closed) unconfirmed();
    else {
      this.pending.add(unconfirmed);
      timer = setTimeout(unconfirmed, CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS);
      timer.unref();
    }
    return observed;
  }

  close(): void {
    this.closed = true;
    for (const unconfirmed of this.pending) unconfirmed();
  }
}

export const CandidateOriginalOutcomeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    attemptId: z.uuid(),
    method: z.enum(['GET', 'HEAD']),
    mode: z.enum(['FULL', 'RANGE', 'HEAD']),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0).max(86400000),
    terminal: z.enum([
      'OUTPUT_COMPLETED',
      'OUTPUT_INTERRUPTED',
      'CAPACITY_REJECTED',
      'INTEGRITY_FAILED',
      'OUTPUT_FAILED',
    ]),
    originalBytes: z.number().int().min(1).max(maxBytes),
    selectedBytes: z.number().int().min(0).max(maxBytes),
    // Bytes offered to the API response stream, not client/disk receipt.
    offeredBytes: z.number().int().min(0).max(maxBytes),
    rangeStart: z
      .number()
      .int()
      .min(0)
      .max(maxBytes - 1)
      .nullable(),
    rangeEnd: z
      .number()
      .int()
      .min(0)
      .max(maxBytes - 1)
      .nullable(),
    errorCode: z
      .enum([
        'CLIENT_CLOSED',
        'CAPACITY_LIMIT',
        'SIZE_MISMATCH',
        'HASH_MISMATCH',
        'AUTHORITY_CHANGED',
        'RANGE_UNSATISFIABLE',
        'UNAVAILABLE',
      ])
      .nullable(),
  })
  .refine(
    (value) =>
      value.offeredBytes <= value.selectedBytes &&
      value.selectedBytes <= value.originalBytes &&
      (value.method === 'HEAD'
        ? value.mode === 'HEAD' &&
          value.offeredBytes === 0 &&
          value.selectedBytes === 0
        : value.mode !== 'HEAD') &&
      (value.rangeStart === null
        ? value.rangeEnd === null
        : value.rangeEnd !== null &&
          value.rangeStart <= value.rangeEnd &&
          value.rangeEnd < value.originalBytes) &&
      (value.terminal === 'OUTPUT_COMPLETED'
        ? value.errorCode === null &&
          value.offeredBytes === value.selectedBytes &&
          (value.mode === 'FULL'
            ? value.selectedBytes === value.originalBytes
            : value.mode !== 'RANGE' ||
              (value.rangeStart !== null &&
                value.rangeEnd !== null &&
                value.selectedBytes === value.rangeEnd - value.rangeStart + 1))
        : value.errorCode !== null) &&
      (value.terminal !== 'CAPACITY_REJECTED' ||
        (value.errorCode === 'CAPACITY_LIMIT' &&
          value.offeredBytes === 0 &&
          value.selectedBytes === 0)) &&
      (value.terminal !== 'INTEGRITY_FAILED' ||
        ((value.errorCode === 'HASH_MISMATCH' ||
          value.errorCode === 'SIZE_MISMATCH') &&
          value.offeredBytes === 0 &&
          value.selectedBytes === 0)),
  );
export type CandidateOriginalOutcome = z.infer<
  typeof CandidateOriginalOutcomeSchema
>;
export type CandidateOriginalOutcomeError = NonNullable<
  CandidateOriginalOutcome['errorCode']
>;

/** One server-owned attempt. The first terminal wins, including finish then close. */
export class CandidateOriginalOutcomeRecorder {
  private readonly started = Date.now();
  readonly attemptId = randomUUID();
  private selectedBytes = 0;
  private offeredBytes = 0;
  private rangeStart: number | null = null;
  private rangeEnd: number | null = null;
  private ready = false;
  private terminal: Promise<void> | undefined;

  constructor(
    private readonly method: 'GET' | 'HEAD',
    private readonly hasRange: boolean,
    private readonly originalBytes: number,
    private readonly append: (
      outcome: CandidateOriginalOutcome,
    ) => Promise<void>,
  ) {}

  select(start: number, end: number) {
    this.ready = true;
    this.selectedBytes = this.method === 'HEAD' ? 0 : end - start + 1;
    if (this.hasRange) {
      this.rangeStart = start;
      this.rangeEnd = end;
    }
  }

  offer(bytes: number) {
    this.offeredBytes += bytes;
  }

  finish() {
    const complete = this.ready && this.offeredBytes === this.selectedBytes;
    return this.end(
      complete ? 'OUTPUT_COMPLETED' : 'OUTPUT_FAILED',
      complete ? null : 'UNAVAILABLE',
    );
  }

  interrupt(error: CandidateOriginalOutcomeError = 'CLIENT_CLOSED') {
    return this.end('OUTPUT_INTERRUPTED', error);
  }

  fail(
    terminal: CandidateOriginalOutcome['terminal'],
    error: CandidateOriginalOutcomeError,
  ) {
    return this.end(terminal, error);
  }

  private end(
    terminal: CandidateOriginalOutcome['terminal'],
    errorCode: CandidateOriginalOutcome['errorCode'],
  ): Promise<void> {
    if (this.terminal) return this.terminal;
    const snapshot = {
      schemaVersion: 1,
      attemptId: this.attemptId,
      method: this.method,
      mode: this.method === 'HEAD' ? 'HEAD' : this.hasRange ? 'RANGE' : 'FULL',
      startedAt: new Date(this.started).toISOString(),
      durationMs: Math.min(86400000, Math.max(0, Date.now() - this.started)),
      terminal,
      originalBytes: this.originalBytes,
      selectedBytes: this.selectedBytes,
      offeredBytes: this.offeredBytes,
      rangeStart: this.rangeStart,
      rangeEnd: this.rangeEnd,
      errorCode,
    };
    // Reserve the terminal before validating or invoking the asynchronous port.
    this.terminal = Promise.resolve().then(() =>
      this.append(CandidateOriginalOutcomeSchema.parse(snapshot)),
    );
    return this.terminal;
  }
}
