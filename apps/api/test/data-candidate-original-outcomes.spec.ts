import { describe, expect, it, vi } from 'vitest';
import {
  CandidateOriginalOutcomeRecorder,
  CandidateOriginalAuditObserver,
  CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS,
  CandidateOriginalOutcomeSchema,
  type CandidateOriginalOutcome,
} from '../src/data-foundation/candidate-original-outcomes.js';

describe('one server-owned original output terminal', () => {
  it('records finish then close only once and does not count it as interruption', async () => {
    const append = vi.fn((_outcome: CandidateOriginalOutcome) =>
      Promise.resolve(),
    );
    const recorder = new CandidateOriginalOutcomeRecorder(
      'GET',
      false,
      10,
      append,
    );
    recorder.select(0, 9);
    recorder.offer(10);
    await Promise.all([
      recorder.finish(),
      recorder.interrupt(),
      recorder.finish(),
    ]);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      terminal: 'OUTPUT_COMPLETED',
      mode: 'FULL',
      offeredBytes: 10,
    });
  });
  it('records close before finish only once, preserving the partial output count', async () => {
    const append = vi.fn((_outcome: CandidateOriginalOutcome) =>
      Promise.resolve(),
    );
    const recorder = new CandidateOriginalOutcomeRecorder(
      'GET',
      true,
      10,
      append,
    );
    recorder.select(2, 8);
    recorder.offer(3);
    await Promise.all([recorder.interrupt(), recorder.finish()]);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      terminal: 'OUTPUT_INTERRUPTED',
      mode: 'RANGE',
      rangeStart: 2,
      rangeEnd: 8,
      offeredBytes: 3,
      selectedBytes: 7,
    });
  });
  it('does not reinterpret a failed append as a new successful terminal', async () => {
    const append = vi.fn(() => Promise.reject(new Error('unconfirmed')));
    const recorder = new CandidateOriginalOutcomeRecorder(
      'HEAD',
      false,
      10,
      append,
    );
    recorder.select(0, 9);
    await expect(recorder.finish()).rejects.toThrow('unconfirmed');
    await expect(recorder.interrupt()).rejects.toThrow('unconfirmed');
    expect(append).toHaveBeenCalledOnce();
  });
  it('does not mark an incomplete service output as completed on finish', async () => {
    const append = vi.fn((_outcome: CandidateOriginalOutcome) =>
      Promise.resolve(),
    );
    const recorder = new CandidateOriginalOutcomeRecorder(
      'GET',
      false,
      10,
      append,
    );
    recorder.select(0, 9);
    recorder.offer(3);
    await recorder.finish();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: 'OUTPUT_FAILED',
        offeredBytes: 3,
        errorCode: 'UNAVAILABLE',
      }),
    );
  });
  it.each([
    { offeredBytes: 11 },
    { method: 'HEAD' },
    { storageUrl: 'http://private-store' },
    { attemptId: 'caller-string' },
    { errorCode: 'SQL error details' },
    { durationMs: 86400001 },
  ])('rejects unsafe or contradictory metadata %j', (change) => {
    expect(
      CandidateOriginalOutcomeSchema.safeParse({
        schemaVersion: 1,
        attemptId: 'ca000000-0000-4000-8000-000000000008',
        method: 'GET',
        mode: 'FULL',
        startedAt: '2026-10-04T00:00:00Z',
        durationMs: 1,
        terminal: 'OUTPUT_COMPLETED',
        originalBytes: 10,
        selectedBytes: 10,
        offeredBytes: 10,
        rangeStart: null,
        rangeEnd: null,
        errorCode: null,
        ...change,
      }).success,
    ).toBe(false);
  });
});

describe('bounded original-audit observation without cancelling SQL', () => {
  it.each(['resolve', 'reject'] as const)(
    'marks deadline uncertainty once before a late %s',
    async (late) => {
      vi.useFakeTimers();
      let resolveTask!: () => void;
      let rejectTask!: (error: Error) => void;
      const task = new Promise<void>((resolve, reject) => {
        resolveTask = resolve;
        rejectTask = reject;
      });
      const report = vi.fn();
      const observer = new CandidateOriginalAuditObserver(report);
      const attemptId = 'ca000000-0000-4000-8000-000000000008';
      const observed = observer.observe(task, attemptId);
      let observationDone = false;
      void observed.then(() => {
        observationDone = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(
          CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS - 1,
        );
        expect(observationDone).toBe(false);
        expect(report).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await observed;
        expect(report).toHaveBeenCalledExactlyOnceWith(
          'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED',
          attemptId,
        );
        expect(observer.observe(task, attemptId)).toBe(observed);
        observer.close();
        if (late === 'resolve') resolveTask();
        else rejectTask(new Error('private database outcome'));
        await Promise.resolve();
        expect(report).toHaveBeenCalledOnce();
      } finally {
        resolveTask();
        observer.close();
        vi.useRealTimers();
      }
    },
  );
  it('ends observations created after module shutdown as unconfirmed once', async () => {
    const report = vi.fn();
    const observer = new CandidateOriginalAuditObserver(report);
    observer.close();
    const task = new Promise<void>(() => {});
    await observer.observe(task, 'ca000000-0000-4000-8000-000000000008');
    await observer.observe(task, 'ca000000-0000-4000-8000-000000000008');
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED',
      'ca000000-0000-4000-8000-000000000008',
    );
  });
});
