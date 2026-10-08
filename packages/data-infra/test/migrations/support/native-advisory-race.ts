import type { PoolClient } from 'pg';
import { expect } from 'vitest';

/** Real PostgreSQL transactions only; observing elapsed time is not lock proof. */
export async function commitAfterAdvisoryWait(
  winner: PoolClient,
  contender: PoolClient,
  winnerWrite: () => Promise<unknown>,
  contenderWrite: () => Promise<unknown>,
): Promise<void> {
  const winnerPid = (
    await winner.query<{ pid: number }>('select pg_backend_pid() pid')
  ).rows[0]!.pid;
  const contenderPid = (
    await contender.query<{ pid: number }>('select pg_backend_pid() pid')
  ).rows[0]!.pid;
  expect(contenderPid).not.toBe(winnerPid);
  await winnerWrite();

  let settled = false;
  // Attach both handlers immediately: an early refusal must fail the lock
  // assertion without becoming an unhandled rejection.
  const outcome = contenderWrite().then(
    () => {
      settled = true;
      return { accepted: true, code: undefined };
    },
    (error: unknown) => {
      settled = true;
      return {
        accepted: false,
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined,
      };
    },
  );

  try {
    let observed = false;
    const deadline = performance.now() + 2_000;
    while (!settled && performance.now() < deadline) {
      const row = (
        await winner.query<{ winner_blocks: boolean; advisory_wait: boolean }>(
          `select $1::integer=any(pg_blocking_pids($2::integer)) winner_blocks,
           exists(select 1 from pg_locks where pid=$2::integer
             and locktype='advisory' and not granted) advisory_wait`,
          [winnerPid, contenderPid],
        )
      ).rows[0]!;
      if (row.winner_blocks && row.advisory_wait) {
        observed = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    expect(settled, 'Contender must remain blocked until winner commits').toBe(
      false,
    );
    expect(
      observed,
      'Actual advisory wait on the winner must be observed',
    ).toBe(true);
    await winner.query('commit');
    expect(await outcome).toEqual({ accepted: false, code: '40001' });
  } finally {
    // Both callers use bounded statement timeouts. Rolling back the holder
    // releases its lock even when the observation/assertion fails.
    await winner.query('rollback');
    await outcome;
    await contender.query('rollback');
  }
}
