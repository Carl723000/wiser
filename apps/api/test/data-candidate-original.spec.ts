import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlatformRequestContext } from '@wiser/platform-contracts';
import { buildApp } from '../src/app.js';
import {
  CandidateOriginalOutcomeSchema,
  CandidateOriginalAuditObserver,
  type CandidateOriginalOutcome,
} from '../src/data-foundation/candidate-original-outcomes.js';
import type { CandidateOriginalPort } from '../src/data-foundation/postgres-candidate-original.js';
import { PostgresDataAssetDownloadPort } from '../src/data-foundation/postgres-asset-download.js';
import { createDataFoundationRestModule } from '../src/data-foundation/rest-module.js';

const tenantId = 'ca000000-0000-4000-8000-000000000001';
const projectId = 'ca000000-0000-4000-8000-000000000002';
const actorId = 'ca000000-0000-4000-8000-000000000003';
const ingestionId = 'ca000000-0000-4000-8000-000000000004';
const processingBatchId = 'ca000000-0000-4000-8000-000000000005';
const assetId = 'ca000000-0000-4000-8000-000000000006';
const uploadId = 'ca000000-0000-4000-8000-000000000007';
const reviewHash = 'a'.repeat(64);
const original = new TextEncoder().encode('原月报，零值0，等级Ⅱ');
const sha256 = createHash('sha256').update(original).digest('hex');
const reference = {
  kind: 'ingestion-candidate' as const,
  ingestionId,
  processingBatchId,
  reviewHash,
};
const context: PlatformRequestContext = {
  principal: {
    actorType: 'human',
    actorId,
    authUserId: actorId,
    sessionId: actorId,
    authenticationMethod: 'supabase_jwt',
  },
  authorization: {
    tenantId,
    projectId,
    roles: ['data-steward'],
    scopes: ['data.operation.read', 'data.ingestion.write'],
    purpose: 'verify-original',
    maxSecurityLevel: 'L3_CONFIDENTIAL',
    authzVersion: 7,
  },
  traceId: 'c'.repeat(32),
};
const url = `/api/data/v1/tenants/${tenantId}/projects/${projectId}/ingestions/${ingestionId}/candidates/${processingBatchId}/assets/${assetId}/content?reviewHash=${reviewHash}`;
const headers = {
  authorization: 'Bearer verified',
  'x-wiser-tenant-id': tenantId,
  'x-wiser-project-id': projectId,
  'x-wiser-purpose': 'verify-original',
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type CandidatePort = CandidateOriginalPort;
function fixture(
  options: {
    body?: Uint8Array | ReadableStream<Uint8Array>;
    current?: PlatformRequestContext;
    revoke?: boolean;
    sign?: () => void;
    sizeBytes?: number;
    sha256?: string;
    fetcher?: typeof globalThis.fetch;
    authorizeCall?: (call: number) => Promise<void>;
    contextForToken?: (token: string) => PlatformRequestContext;
    outcomeFailure?: boolean;
    omitOutcomePort?: boolean;
    downloadWait?: Promise<void>;
    outcomeTask?: Promise<void>;
  } = {},
) {
  let reads = 0;
  const download = vi.fn(async () => {
    options.sign?.();
    await options.downloadWait;
    return {
      outcomeReceipt: Object.freeze({}),
      url: 'http://private-store/candidate',
      expiresAt: '2099-01-01T00:00:00Z',
      sha256: options.sha256 ?? sha256,
      sizeBytes: options.sizeBytes ?? original.byteLength,
    };
  });
  const authorize = vi.fn(() => {
    reads += 1;
    if (options.revoke && reads > 1)
      return Promise.reject(
        Object.assign(new Error('private db detail'), { code: 'NOT_FOUND' }),
      );
    return options.authorizeCall?.(reads) ?? Promise.resolve();
  });
  const fetch = vi.fn(
    options.fetcher ??
      (() =>
        Promise.resolve(
          new Response(options.body ?? original, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
        )),
  );
  const outcome = vi.fn(
    (_receipt: object, _outcome: CandidateOriginalOutcome) =>
      options.outcomeFailure
        ? Promise.reject(new Error('private audit detail'))
        : (options.outcomeTask ?? Promise.resolve()),
  );
  const resolver = vi.fn((input: { token: string }) =>
    Promise.resolve(
      options.contextForToken?.(input.token) ?? options.current ?? context,
    ),
  );
  const app = buildApp({
    logger: false,
    modules: [
      createDataFoundationRestModule({
        resolver: { resolve: resolver },
        handler: { execute: () => Promise.resolve({}) },
        assetDownload: {
          createDownload: () =>
            Promise.reject(
              new Error('Published download must remain separate'),
            ),
          createCandidateDownload: download,
          authorizeCandidateDownload: authorize,
          ...(options.omitOutcomePort
            ? {}
            : { appendCandidateOriginalOutcome: outcome }),
        },
        assetContentFetch: fetch,
      }),
    ],
  });
  apps.push(app);
  return { app, download, authorize, fetch, resolver, outcome };
}

describe('candidate original service-output outcomes', () => {
  it.each([
    ['GET', undefined, 'FULL', original.byteLength],
    ['GET', 'bytes=0-2', 'RANGE', 3],
    ['HEAD', undefined, 'HEAD', 0],
    ['HEAD', 'bytes=0-2', 'HEAD', 0],
  ] as const)(
    'records %s %s after response finish with distinct server attempts',
    async (method, range, mode, offeredBytes) => {
      const f = fixture();
      const response = await f.app.inject({
        method,
        url,
        headers: { ...headers, ...(range ? { range } : {}) },
      });
      expect(response.statusCode).toBe(range ? 206 : 200);
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'OUTPUT_COMPLETED',
        method,
        mode,
        selectedBytes: offeredBytes,
        offeredBytes,
        rangeStart: range ? 0 : null,
        rangeEnd: range ? 2 : null,
        originalBytes: original.byteLength,
        errorCode: null,
      });
      expect(f.outcome.mock.calls[0]?.[1]).toHaveProperty(
        'attemptId',
        expect.stringMatching(/^[a-f0-9-]{36}$/),
      );
      expect(JSON.stringify(f.outcome.mock.calls)).not.toContain(
        'private-store',
      );
    },
  );
  it.each([
    ['hash', original, 'b'.repeat(64), 'HASH_MISMATCH'],
    ['short', original.subarray(0, 2), sha256, 'SIZE_MISMATCH'],
    [
      'oversized',
      new Uint8Array(original.byteLength + 1),
      sha256,
      'SIZE_MISMATCH',
    ],
  ] as const)(
    'records the bounded %s integrity failure without disclosing original bytes',
    async (_kind, body, expectedHash, errorCode) => {
      const f = fixture({ body, sha256: expectedHash });
      const response = await f.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain('原月报');
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'INTEGRITY_FAILED',
        errorCode,
        offeredBytes: 0,
      });
    },
  );
  it('records capacity rejection and does not fetch a third original', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      fetcher: () => new Promise<Response>((resolve) => waiting.push(resolve)),
    });
    const first = f.app.inject({ method: 'GET', url, headers });
    const second = f.app.inject({ method: 'HEAD', url, headers });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      const excess = await f.app.inject({ method: 'GET', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(excess.headers['retry-after']).toBe('1');
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'CAPACITY_REJECTED',
        errorCode: 'CAPACITY_LIMIT',
        offeredBytes: 0,
      });
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second]);
    }
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledTimes(3));
    const attempts = f.outcome.mock.calls.map(
      (call) => (call[1] as { attemptId: string }).attemptId,
    );
    expect(new Set(attempts).size).toBe(3);
  });
});

describe('candidate original output audit failures', () => {
  it('fails closed before signing or fetching when the trusted outcome port is absent', async () => {
    const f = fixture({ omitOutcomePort: true });
    expect(
      (await f.app.inject({ method: 'GET', url, headers })).statusCode,
    ).toBe(503);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.outcome).not.toHaveBeenCalled();
  });
  it('records cancellation that happened before the signing promise returned its receipt', async () => {
    let resume!: () => void;
    const downloadWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = fixture({ downloadWait });
    const caller = new AbortController();
    const request = f.app.inject({
      method: 'GET',
      url,
      headers,
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(f.download).toHaveBeenCalledOnce());
    caller.abort();
    await expect(request).rejects.toThrow();
    resume();
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'OUTPUT_INTERRUPTED',
      errorCode: 'CLIENT_CLOSED',
      offeredBytes: 0,
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('reports an unconfirmed append with a fixed diagnostic without rewriting delivered output', async () => {
    const f = fixture({ outcomeFailure: true });
    const log = vi.spyOn(f.app.log, 'error');
    const response = await f.app.inject({ method: 'GET', url, headers });
    expect(response.rawPayload).toEqual(Buffer.from(original));
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log.mock.calls[0]).toEqual([
      {
        code: 'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_FAILED',
        attemptId: f.outcome.mock.calls[0]?.[1].attemptId,
      },
      'Candidate original output audit was not confirmed.',
    ]);
    expect(f.outcome).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });
  it('correlates two independent failed attempts without names, URLs or exception details', async () => {
    const f = fixture({ outcomeFailure: true });
    const log = vi.spyOn(f.app.log, 'error');
    for (let index = 0; index < 2; index++)
      expect(
        (await f.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(200);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    const logged = log.mock.calls.map(
      (call) => (call[0] as { attemptId: string }).attemptId,
    );
    expect(new Set(logged).size).toBe(2);
    expect(logged).toEqual(
      f.outcome.mock.calls.map((call) => call[1].attemptId),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private|Bearer|原月报|SQL/,
    );
  });
  it('records the offered prefix when authority is lost during response output', async () => {
    const bytes = new Uint8Array(128 * 1024).fill(65);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      authorizeCall: (call) =>
        call === 4
          ? Promise.reject(
              Object.assign(new Error('private changed scope'), {
                code: 'FORBIDDEN',
              }),
            )
          : Promise.resolve(),
    });
    await expect(
      f.app.inject({ method: 'GET', url, headers }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'OUTPUT_INTERRUPTED',
      errorCode: 'AUTHORITY_CHANGED',
      offeredBytes: 65536,
      selectedBytes: bytes.byteLength,
    });
  });
  it.each([
    { code: 'UNAVAILABLE', expected: 'UNAVAILABLE' },
    { code: undefined, expected: 'UNAVAILABLE' },
    { code: 'NOT_FOUND', expected: 'AUTHORITY_CHANGED' },
  ] as const)(
    'classifies a streaming authorization $code failure without inventing an authority change',
    async ({ code, expected }) => {
      const bytes = new Uint8Array(128 * 1024).fill(65);
      const f = fixture({
        body: bytes,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        authorizeCall: (call) =>
          call === 4
            ? Promise.reject(
                Object.assign(new Error('private authorization failure'), {
                  ...(code ? { code } : {}),
                }),
              )
            : Promise.resolve(),
      });
      await expect(
        f.app.inject({ method: 'GET', url, headers }),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'OUTPUT_INTERRUPTED',
        errorCode: expected,
        offeredBytes: 65536,
        selectedBytes: bytes.byteLength,
      });
    },
  );
  it('records a temporarily unavailable context resolver separately from changed streaming authority', async () => {
    const bytes = new Uint8Array(128 * 1024).fill(65);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    let resolves = 0;
    f.resolver.mockImplementation(() =>
      ++resolves === 5
        ? Promise.reject(new Error('private resolver unavailable'))
        : Promise.resolve(context),
    );
    await expect(
      f.app.inject({ method: 'GET', url, headers }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'OUTPUT_INTERRUPTED',
      errorCode: 'UNAVAILABLE',
      offeredBytes: 65536,
      selectedBytes: bytes.byteLength,
    });
  });
  it.each([2, 3])(
    'preserves temporary context failure before output at current check %i',
    async (failedCheck) => {
      const f = fixture();
      let resolves = 0;
      f.resolver.mockImplementation(() =>
        ++resolves === failedCheck
          ? Promise.reject(new Error('private resolver unavailable'))
          : Promise.resolve(context),
      );
      const response = await f.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toMatch(/private|原月报/);
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'OUTPUT_FAILED',
        errorCode: 'UNAVAILABLE',
        offeredBytes: 0,
      });
    },
  );
  it('bounds original-audit shutdown even when the trusted append promise never settles', async () => {
    let settle!: () => void;
    const outcomeTask = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const f = fixture({ outcomeTask });
    const log = vi.spyOn(f.app.log, 'error');
    const response = await f.app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    let closed = false;
    const closing = f.app.close().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 150 });
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]?.[0]).toEqual({
        code: 'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED',
        attemptId: f.outcome.mock.calls[0]?.[1].attemptId,
      });
    } finally {
      // Clean up the baseline's infinite wait without weakening the assertion.
      settle();
      await closing;
    }
  });
  it('diagnoses one failed terminal only once across finish followed by close', async () => {
    const f = fixture({ outcomeFailure: true });
    const log = vi.spyOn(f.app.log, 'error');
    const response = await f.app.inject({ method: 'GET', url, headers });
    await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
    response.raw.res.emit('close');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.outcome).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });
  it.each(['GET', 'HEAD'] as const)(
    'records an unsatisfiable %s range as a rejection rather than completed output',
    async (method) => {
      const f = fixture();
      expect(
        (
          await f.app.inject({
            method,
            url,
            headers: { ...headers, range: 'bytes=999999-' },
          })
        ).statusCode,
      ).toBe(416);
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'OUTPUT_FAILED',
        errorCode: 'RANGE_UNSATISFIABLE',
        offeredBytes: 0,
      });
    },
  );
});

describe('candidate original error responses independent of pending audit observation', () => {
  it.each(['GET', 'HEAD'] as const)(
    'returns an unsatisfiable %s range before its audit append settles',
    async (method) => {
      let settle!: () => void;
      const outcomeTask = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const f = fixture({ outcomeTask });
      let responded = false;
      const request = f.app
        .inject({
          method,
          url,
          headers: { ...headers, range: 'bytes=999999-' },
        })
        .then((response) => {
          responded = true;
          return response;
        });
      try {
        await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(responded).toBe(true);
        expect((await request).statusCode).toBe(416);
        expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
          terminal: 'OUTPUT_FAILED',
          errorCode: 'RANGE_UNSATISFIABLE',
          offeredBytes: 0,
        });
      } finally {
        settle();
        await request;
      }
    },
  );
  it.each(['integrity', 'fetch', 'authorization'] as const)(
    'returns a verified %s failure before its audit append settles',
    async (kind) => {
      let settle!: () => void;
      const outcomeTask = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const f = fixture({
        outcomeTask,
        ...(kind === 'integrity' ? { sha256: 'b'.repeat(64) } : {}),
        ...(kind === 'fetch'
          ? {
              fetcher: () =>
                Promise.reject(
                  Object.assign(new Error('private unavailable upstream'), {
                    code: 'UNAVAILABLE',
                  }),
                ),
            }
          : {}),
        ...(kind === 'authorization'
          ? {
              authorizeCall: (call: number) =>
                call === 2
                  ? Promise.reject(
                      Object.assign(
                        new Error('private unavailable authority'),
                        {
                          code: 'UNAVAILABLE',
                        },
                      ),
                    )
                  : Promise.resolve(),
            }
          : {}),
      });
      let responded = false;
      const request = f.app
        .inject({ method: 'GET', url, headers })
        .then((response) => {
          responded = true;
          return response;
        });
      try {
        await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(responded).toBe(true);
        expect((await request).statusCode).toBe(503);
        expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
          terminal: kind === 'integrity' ? 'INTEGRITY_FAILED' : 'OUTPUT_FAILED',
          errorCode: kind === 'integrity' ? 'HASH_MISMATCH' : 'UNAVAILABLE',
          offeredBytes: 0,
        });
      } finally {
        settle();
        await request;
      }
    },
  );
  it('returns capacity rejection before the audit settles without fetching a third original', async () => {
    let settle!: () => void;
    const outcomeTask = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      outcomeTask,
      fetcher: () => new Promise<Response>((resolve) => waiting.push(resolve)),
    });
    const first = f.app.inject({ method: 'GET', url, headers }).then((r) => r);
    const second = f.app
      .inject({ method: 'HEAD', url, headers })
      .then((r) => r);
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    let responded = false;
    const excess = f.app
      .inject({ method: 'GET', url, headers })
      .then((response) => {
        responded = true;
        return response;
      });
    try {
      await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(responded).toBe(true);
      const response = await excess;
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
        terminal: 'CAPACITY_REJECTED',
        errorCode: 'CAPACITY_LIMIT',
        offeredBytes: 0,
      });
    } finally {
      settle();
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second, excess]);
    }
  });
  it('releases only the settled original reservation while its audit is still pending', async () => {
    let settle!: () => void;
    const outcomeTask = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waiting: Array<(response: Response) => void> = [];
    let fetches = 0;
    const f = fixture({
      outcomeTask,
      fetcher: () =>
        fetches++ === 0
          ? Promise.resolve(new Response(original))
          : new Promise<Response>((resolve) => waiting.push(resolve)),
    });
    const failed = f.app
      .inject({
        method: 'GET',
        url,
        headers: { ...headers, range: 'bytes=999999-' },
      })
      .then((r) => r);
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    const first = f.app.inject({ method: 'HEAD', url, headers }).then((r) => r);
    const second = f.app
      .inject({ method: 'HEAD', url, headers })
      .then((r) => r);
    try {
      await vi.waitFor(() => expect(f.download).toHaveBeenCalledTimes(3));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(waiting).toHaveLength(2);
      expect(f.fetch).toHaveBeenCalledTimes(3);
    } finally {
      settle();
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([failed, first, second]);
    }
  });
});

describe('fixed pending original HTTP delivery', () => {
  it('bounds concurrent GET, HEAD and Range upstream reads for one responsible actor', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const first = f.app.inject({ method: 'GET', url, headers });
    const second = f.app.inject({ method: 'HEAD', url, headers });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      const excess = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range: 'bytes=0-0' },
      });
      expect(excess.statusCode).toBe(503);
      expect(excess.headers['retry-after']).toBe('1');
      expect(excess.body).not.toContain('private-store');
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second]);
    }
  });

  it('shares the responsible human limit with delegated agents', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const agentContext = (id: string): PlatformRequestContext => ({
      ...context,
      principal: {
        actorType: 'agent',
        actorId: id,
        credentialId: id,
        delegationId: id,
        delegatedBy: actorId,
        authenticationMethod: 'delegated_credential',
      },
    });
    const f = fixture({
      contextForToken: (token) =>
        token === 'agent-a'
          ? agentContext('ca000000-0000-4000-8000-000000000008')
          : token === 'agent-b'
            ? agentContext('ca000000-0000-4000-8000-000000000009')
            : context,
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const first = f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, authorization: 'Bearer agent-a' },
    });
    const second = f.app.inject({
      method: 'HEAD',
      url,
      headers: { ...headers, authorization: 'Bearer agent-b' },
    });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      const excess = await f.app.inject({ method: 'GET', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all([first, second]);
    }
  });

  it('bounds the whole API instance across distinct responsible actors', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      contextForToken: (token) => {
        const id = `ca000000-0000-4000-8000-0000000000${token.padStart(2, '0')}`;
        return {
          ...context,
          principal: {
            ...context.principal,
            actorId: id,
            authUserId: id,
            sessionId: id,
          },
        };
      },
      fetcher: () =>
        waiting.length < 4
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const requests = [1, 2, 3, 4].map((actor) =>
      f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: `Bearer ${actor}` },
      }),
    );
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(4));
      const excess = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: 'Bearer 5' },
      });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(4);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await Promise.all(requests);
    }
  });

  it.each([0, 32 * 1024 * 1024 + 1])(
    'rejects an invalid authorized size before fetching original bytes: %s',
    async (sizeBytes) => {
      const f = fixture({ sizeBytes });
      const response = await f.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(503);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it('releases the reservation after HEAD, 416, an upstream failure and an authorization refusal', async () => {
    const normal = fixture();
    for (let index = 0; index < 3; index++) {
      const head = await normal.app.inject({ method: 'HEAD', url, headers });
      expect(head.statusCode).toBe(200);
      const unsatisfiable = await normal.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range: 'bytes=999999-' },
      });
      expect(unsatisfiable.statusCode).toBe(416);
    }
    expect(normal.fetch).toHaveBeenCalledTimes(6);

    const failed = fixture({
      fetcher: () => Promise.reject(new Error('private store failure')),
    });
    for (let index = 0; index < 3; index++)
      expect(
        (await failed.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(500);
    expect(failed.fetch).toHaveBeenCalledTimes(3);

    const refused = fixture({
      authorizeCall: (call) =>
        call % 2 === 0
          ? Promise.reject(
              Object.assign(new Error('candidate withdrawn'), {
                code: 'FORBIDDEN',
              }),
            )
          : Promise.resolve(),
    });
    for (let index = 0; index < 3; index++)
      expect(
        (await refused.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(403);
    expect(refused.fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps slow or unconsumed response bytes reserved until the client closes', async () => {
    const bytes = new Uint8Array(256 * 1024).fill(65);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const first = await f.app.inject({
      method: 'GET',
      url,
      headers,
      payloadAsStream: true,
    });
    const second = await f.app.inject({
      method: 'GET',
      url,
      headers,
      payloadAsStream: true,
    });
    try {
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const excess = await f.app.inject({ method: 'HEAD', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally {
      first.raw.res.destroy();
      second.raw.res.destroy();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovered = await f.app.inject({ method: 'HEAD', url, headers });
    expect(recovered.statusCode).toBe(200);
  });

  it('keeps a fresh authorization check before each delivered chunk', async () => {
    const bytes = new Uint8Array(128 * 1024).fill(66);
    const f = fixture({
      body: bytes,
      sizeBytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const response = await f.app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from(bytes));
    expect(f.authorize).toHaveBeenCalledTimes(4);
  });

  it('releases the budget when an in-flight client cancels and after principal expiry', async () => {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let hold = true;
    const f = fixture({
      fetcher: (_input, init) =>
        hold
          ? new Promise<Response>((_resolve, reject) => {
              started();
              init?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            })
          : Promise.resolve(new Response(original)),
    });
    const caller = new AbortController();
    const pending = f.app.inject({
      method: 'GET',
      url,
      headers,
      signal: caller.signal,
    });
    await fetching;
    caller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.outcome).toHaveBeenCalledOnce());
    expect(f.outcome.mock.calls[0]?.[1]).toMatchObject({
      terminal: 'OUTPUT_INTERRUPTED',
      errorCode: 'CLIENT_CLOSED',
      offeredBytes: 0,
    });
    hold = false;
    for (let index = 0; index < 3; index++)
      expect(
        (await f.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(200);

    const state = {
      current: context,
      expireOnFetch: true,
      fetcher: () => {
        if (state.expireOnFetch)
          state.current = {
            ...context,
            principal: {
              ...context.principal,
              expiresAt: '2020-01-01T00:00:00Z',
            },
          };
        return Promise.resolve(new Response(original));
      },
    };
    const expiry = fixture(state);
    expect(
      (await expiry.app.inject({ method: 'GET', url, headers })).statusCode,
    ).toBe(403);
    state.current = context;
    state.expireOnFetch = false;
    for (let index = 0; index < 3; index++)
      expect(
        (await expiry.app.inject({ method: 'GET', url, headers })).statusCode,
      ).toBe(200);
  });

  it('holds a cancelled request slot until a non-cooperative upstream fetch settles', async () => {
    const waiting: Array<(response: Response) => void> = [];
    const f = fixture({
      fetcher: () =>
        waiting.length < 2
          ? new Promise<Response>((resolve) => waiting.push(resolve))
          : Promise.resolve(new Response(original)),
    });
    const caller = new AbortController();
    const cancelled = f.app.inject({
      method: 'GET',
      url,
      headers,
      signal: caller.signal,
    });
    const second = f.app.inject({ method: 'GET', url, headers });
    try {
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      caller.abort();
      await expect(cancelled).rejects.toThrow();
      const excess = await f.app.inject({ method: 'HEAD', url, headers });
      expect(excess.statusCode).toBe(503);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      waiting[0]!(new Response(original));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const recovered = await f.app.inject({ method: 'HEAD', url, headers });
      expect(recovered.statusCode).toBe(200);
    } finally {
      for (const resolve of waiting) resolve(new Response(original));
      await second;
    }
  });

  it('serves exact original bytes without a published version or signed redirect', async () => {
    const f = fixture();
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.from(original));
    expect(r.headers.location).toBeUndefined();
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['content-disposition']).toBe('attachment');
    expect(f.download).toHaveBeenCalledWith({ context, reference, assetId });
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('checks the full hash before releasing even a valid byte range', async () => {
    const f = fixture();
    const r = await f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=0-5' },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload).toEqual(Buffer.from(original).subarray(0, 6));
    expect(r.headers['content-range']).toBe(`bytes 0-5/${original.byteLength}`);
  });
  it.each([new Uint8Array(original.byteLength).fill(65), original.slice(1)])(
    'withholds changed or truncated quarantine bytes',
    async (body) => {
      const f = fixture({ body });
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('private-store');
      expect(r.body).not.toContain('原月报');
      expect(r.headers.location).toBeUndefined();
    },
  );
  it('does not release bytes after a frozen candidate is superseded or withdrawn', async () => {
    const f = fixture({ revoke: true });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('原月报');
    expect(f.authorize).toHaveBeenCalled();
  });
  it('withholds delivery when current authority changes while signing', async () => {
    const options = { current: context, sign: () => {} };
    options.sign = () => {
      options.current = {
        ...context,
        authorization: { ...context.authorization, authzVersion: 8 },
      };
    };
    const f = fixture(options);
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(403);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('denies a catalog-only reader without maintenance or independent review authority', async () => {
    const f = fixture({
      current: {
        ...context,
        authorization: {
          ...context.authorization,
          scopes: ['data.catalog.read'],
        },
      },
    });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(403);
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each([
    url.replace(reviewHash, 'f'.repeat(63)),
    `${url}&versionId=${assetId}`,
    url.replace(assetId + '/content', 'source/content'),
    `${url}&reviewHash=${reviewHash}`,
  ])(
    'rejects incomplete, aliased or repeated fixed references: %s',
    async (url) => {
      const f = fixture();
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(422);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it('verifies copied bytes when a reader reuses its underlying buffer', async () => {
    const shared = new Uint8Array(1);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset === original.length) {
            controller.close();
            return;
          }
          shared[0] = original[offset++]!;
          controller.enqueue(shared);
        },
      },
      { highWaterMark: 0 },
    );
    const f = fixture({ body });
    const r = await f.app.inject({ method: 'GET', url, headers });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.from(original));
  });
  it.each(['bytes=1-0', 'bytes=-0'])(
    'rejects unsatisfiable single ranges: %s',
    async (range) => {
      const f = fixture();
      const r = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range },
      });
      expect(r.statusCode).toBe(416);
      expect(r.body).toBe('');
    },
  );
  it.each(['bytes=0-1,3-4', 'bytes=1-a'])(
    'rejects unsupported range syntax: %s',
    async (range) => {
      const f = fixture();
      const r = await f.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, range },
      });
      expect(r.statusCode).toBe(422);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...context, authorization: { ...context.authorization, purpose: ' ' } },
    {
      ...context,
      principal: { ...context.principal, expiresAt: '2020-01-01T00:00:00Z' },
    },
    { ...context, principal: { ...context.principal, delegatedBy: actorId } },
    {
      ...context,
      authorization: { ...context.authorization, tenantId: actorId },
    },
  ])(
    'rejects unavailable purpose, identity or tenant authority',
    async (current) => {
      const f = fixture({ current });
      const r = await f.app.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(403);
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it('returns body-free HEAD and rejects unsatisfiable ranges after original verification', async () => {
    const f = fixture();
    const head = await f.app.inject({ method: 'HEAD', url, headers });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String(original.byteLength));
    const r = await f.app.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=999999-' },
    });
    expect(r.statusCode).toBe(416);
    expect(r.headers['content-range']).toBe(`bytes */${original.byteLength}`);
    expect(r.body).toBe('');
  });
});

function databaseFixture(
  row: Record<string, unknown> | null = {
    source_hash: sha256,
    content_hash: sha256,
    blob_hash: sha256,
    storage_key: `tenants/${tenantId}/projects/${projectId}/quarantine/${uploadId}/object`,
    byte_size: original.byteLength,
    media_type: 'application/octet-stream',
    security_level: 'L0_PUBLIC',
    policy_version: 7,
  },
  failOutcome = false,
  options: {
    signingCommitWait?: Promise<void>;
    outcomeCommitWait?: Promise<void>;
    failOutcomeCommit?: boolean;
  } = {},
) {
  const queries: { text: string; values?: readonly unknown[] }[] = [];
  let commits = 0;
  const client = {
    query(text: string, values?: readonly unknown[]) {
      queries.push({ text, ...(values ? { values } : {}) });
      if (text === 'COMMIT') {
        commits += 1;
        if (commits === 1 && options.signingCommitWait)
          return options.signingCommitWait.then(() => ({ rows: [] }));
        if (commits === 2 && options.failOutcomeCommit)
          return Promise.reject(new Error('private COMMIT outcome unknown'));
        if (commits === 2 && options.outcomeCommitWait)
          return options.outcomeCommitWait.then(() => ({ rows: [] }));
      }
      if (failOutcome && text.includes('data.candidate-original.outcome */'))
        return Promise.reject(new Error('private SQL error'));
      return Promise.resolve({
        rows: text.includes('candidate-original.lookup')
          ? row
            ? [row]
            : []
          : [],
      });
    },
    release: vi.fn(),
  };
  const signer = vi.fn(() =>
    Promise.resolve({
      bucket: 'authority',
      key: 'never-output',
      url: 'http://private-store/original',
      expiresAt: '2099-01-01T00:00:00Z',
    }),
  );
  const port = new PostgresDataAssetDownloadPort({
    pool: {
      connect: () => Promise.resolve(client),
      end: () => Promise.resolve(),
    },
    objectStore: {
      planVersionDownload: () =>
        Promise.reject(new Error('no published version')),
      planCandidateDownload: signer,
    },
  });
  return { port: port as unknown as CandidatePort, signer, queries, client };
}
describe('pending original fixed authority database boundary', () => {
  it('uses canonical current UUIDs for original-read RLS, including an uppercase reviewer', async () => {
    const f = databaseFixture();
    const reviewer = {
      ...context,
      principal: {
        ...context.principal,
        actorId: actorId.toUpperCase(),
        authUserId: actorId.toUpperCase(),
      },
      authorization: {
        ...context.authorization,
        scopes: ['data.operation.read', 'data.publish'],
      },
    };
    await f.port.authorizeCandidateDownload({
      context: reviewer,
      reference,
      assetId,
    });
    expect(
      f.queries
        .find((query) => query.text.includes('data.ingestion.candidate.scope'))
        ?.values?.slice(0, 3),
    ).toEqual([actorId, 'human', '']);
    expect(f.signer).not.toHaveBeenCalled();
    const fixed = f.queries.findIndex((q) =>
      q.text.includes('wiser.candidate_fixed_refs'),
    );
    const lookup = f.queries.findIndex((q) =>
      q.text.includes('candidate-original.lookup'),
    );
    expect(fixed).toBeGreaterThan(-1);
    expect(fixed).toBeLessThan(lookup);
    expect(JSON.parse(String(f.queries[fixed]!.values?.at(-1)))).toEqual([
      reference,
    ]);
  });

  it('signs only the original upload derived from a current fixed candidate and audits it', async () => {
    const f = databaseFixture();
    const r = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    expect(r).toEqual({
      url: 'http://private-store/original',
      expiresAt: '2099-01-01T00:00:00Z',
      sha256,
      sizeBytes: original.byteLength,
    });
    expect(f.signer).toHaveBeenCalledWith({
      tenantId,
      projectId,
      uploadId,
      sizeBytes: original.byteLength,
      contentType: 'application/octet-stream',
      sha256,
      ttlSeconds: 60,
    });
    expect(
      f.queries.some(
        (q) =>
          q.text.includes('candidate-original.scope') &&
          q.values?.includes(reviewHash),
      ),
    ).toBe(true);
    expect(
      f.queries.some(
        (q) =>
          q.text.includes('candidate-original.audit') &&
          q.values?.includes(ingestionId),
      ),
    ).toBe(true);
    expect(f.queries.at(-1)?.text).toBe('COMMIT');
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'other-project-key', 'changed-hash'])(
    'does not sign an unavailable or conflicting fixed original: %s',
    async (change) => {
      const row = {
        source_hash: sha256,
        content_hash: change === 'changed-hash' ? reviewHash : sha256,
        blob_hash: sha256,
        storage_key: `tenants/${tenantId}/projects/${change === 'other-project-key' ? actorId : projectId}/quarantine/${uploadId}/object`,
        byte_size: original.byteLength,
        media_type: 'application/octet-stream',
        security_level: 'L0_PUBLIC',
        policy_version: 7,
      };
      const f = databaseFixture(change === 'missing' ? null : row);
      await expect(
        f.port.createCandidateDownload({ context, reference, assetId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(f.signer).not.toHaveBeenCalled();
      expect(f.queries.at(-1)?.text).toBe('ROLLBACK');
    },
  );
});

function completedOutcome() {
  return CandidateOriginalOutcomeSchema.parse({
    schemaVersion: 1,
    attemptId: 'ca000000-0000-4000-8000-000000000008',
    method: 'GET',
    mode: 'FULL',
    startedAt: '2026-10-04T00:00:00Z',
    durationMs: 1,
    terminal: 'OUTPUT_COMPLETED',
    originalBytes: original.byteLength,
    selectedBytes: original.byteLength,
    offeredBytes: original.byteLength,
    rangeStart: null,
    rangeEnd: null,
    errorCode: null,
  });
}

describe('candidate original trusted append-only output carrier', () => {
  it('appends one terminal with the frozen signing actor, original policy and no URL or raw bytes', async () => {
    const f = databaseFixture();
    const mutable = structuredClone(context);
    const download = await f.port.createCandidateDownload({
      context: mutable,
      reference,
      assetId,
    });
    mutable.principal.actorId = uploadId;
    const terminal = completedOutcome();
    await Promise.all([
      f.port.appendCandidateOriginalOutcome(download.outcomeReceipt, terminal),
      f.port.appendCandidateOriginalOutcome(download.outcomeReceipt, terminal),
    ]);
    const appends = f.queries.filter((q) =>
      q.text.includes('data.candidate-original.outcome */'),
    );
    expect(appends).toHaveLength(1);
    expect(appends[0]?.values?.slice(0, 7)).toEqual([
      tenantId,
      projectId,
      terminal.attemptId,
      actorId,
      ingestionId,
      'OUTPUT_COMPLETED',
      context.authorization.purpose,
    ]);
    expect(appends[0]?.values?.slice(8)).toEqual(['L0_PUBLIC', 7]);
    const metadata: unknown = JSON.parse(String(appends[0]?.values?.[7]));
    expect(metadata).toMatchObject({
      ...terminal,
      assetId,
      processingBatchId,
      reviewHash,
      byteMeaning: 'offered-to-api-response-stream',
    });
    expect(JSON.stringify(appends)).not.toMatch(
      /private-store|原月报|storage_key/,
    );
    expect(
      f.queries.filter((q) =>
        q.text.includes('data.candidate-original.audit */'),
      ),
    ).toHaveLength(1);
    expect(f.queries.some((q) => /update|delete/i.test(q.text))).toBe(false);
    expect(f.signer).toHaveBeenCalledOnce();
    expect(f.queries.at(-1)?.text).toBe('COMMIT');
  });
  it('freezes responsibility before signing COMMIT completes, preserving ALLOWED and output attribution', async () => {
    let resume!: () => void;
    const signingCommitWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = databaseFixture(undefined, false, { signingCommitWait });
    const mutable = {
      ...context,
      principal: { ...context.principal },
      authorization: { ...context.authorization },
    };
    const pending = f.port.createCandidateDownload({
      context: mutable,
      reference,
      assetId,
    });
    await vi.waitFor(() =>
      expect(f.queries.some((q) => q.text === 'COMMIT')).toBe(true),
    );
    mutable.principal.actorId = uploadId;
    mutable.authorization.tenantId = actorId;
    mutable.authorization.projectId = uploadId;
    mutable.authorization.authzVersion = 99;
    resume();
    const download = await pending;
    await f.port.appendCandidateOriginalOutcome(
      download.outcomeReceipt,
      completedOutcome(),
    );
    expect(
      f.queries
        .find((q) => q.text.includes('data.candidate-original.audit */'))
        ?.values?.slice(0, 3),
    ).toEqual([tenantId, projectId, actorId]);
    expect(
      f.queries
        .find((q) => q.text.includes('data.candidate-original.outcome */'))
        ?.values?.slice(0, 4),
    ).toEqual([tenantId, projectId, completedOutcome().attemptId, actorId]);
    expect(
      f.queries.find((q) =>
        q.text.includes('data.candidate-original.outcome-scope */'),
      )?.values,
    ).toEqual([
      tenantId,
      projectId,
      context.authorization.maxSecurityLevel,
      '7',
    ]);
  });
  it('retains an unconfirmed COMMIT and does not repeat INSERT or change historical ALLOWED', async () => {
    const f = databaseFixture(undefined, false, { failOutcomeCommit: true });
    const download = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    for (let index = 0; index < 2; index++)
      await expect(
        f.port.appendCandidateOriginalOutcome(
          download.outcomeReceipt,
          completedOutcome(),
        ),
      ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(
      f.queries.filter((q) =>
        q.text.includes('data.candidate-original.outcome */'),
      ),
    ).toHaveLength(1);
    expect(
      f.queries.filter((q) =>
        q.text.includes('data.candidate-original.audit */'),
      ),
    ).toHaveLength(1);
    expect(f.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(2);
    expect(f.queries.some((q) => /update|delete/i.test(q.text))).toBe(false);
  });
  it('does not release a connection or claim rollback while an unconfirmed SQL promise is running', async () => {
    let resume!: () => void;
    const outcomeCommitWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const f = databaseFixture(undefined, false, { outcomeCommitWait });
    const download = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    const terminal = completedOutcome();
    const pending = f.port.appendCandidateOriginalOutcome(
      download.outcomeReceipt,
      terminal,
    );
    await vi.waitFor(() =>
      expect(f.queries.filter((q) => q.text === 'COMMIT')).toHaveLength(2),
    );
    const report = vi.fn();
    const observer = new CandidateOriginalAuditObserver(report);
    const observed = observer.observe(pending, terminal.attemptId);
    observer.close();
    await observed;
    expect(report).toHaveBeenCalledWith(
      'CANDIDATE_ORIGINAL_OUTCOME_AUDIT_UNCONFIRMED',
      terminal.attemptId,
    );
    expect(f.client.release).toHaveBeenCalledOnce();
    expect(f.queries.some((q) => q.text === 'ROLLBACK')).toBe(false);
    resume();
    await pending;
    expect(f.client.release).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledOnce();
  });
  it('rejects forged or mutated receipts and conflicting terminals before a new DB write', async () => {
    const f = databaseFixture();
    const download = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    const terminal = completedOutcome();
    const prior = f.queries.length;
    const other = databaseFixture();
    await expect(
      other.port.appendCandidateOriginalOutcome(
        download.outcomeReceipt,
        terminal,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(other.queries).toHaveLength(0);
    await expect(
      f.port.appendCandidateOriginalOutcome({}, terminal),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      f.port.appendCandidateOriginalOutcome(
        { ...download.outcomeReceipt },
        terminal,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      f.port.appendCandidateOriginalOutcome(download.outcomeReceipt, {
        ...terminal,
        originalBytes: original.byteLength - 1,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.queries).toHaveLength(prior);
    await f.port.appendCandidateOriginalOutcome(
      download.outcomeReceipt,
      terminal,
    );
    const appended = f.queries.length;
    await expect(
      f.port.appendCandidateOriginalOutcome(download.outcomeReceipt, {
        ...terminal,
        terminal: 'OUTPUT_INTERRUPTED',
        errorCode: 'CLIENT_CLOSED',
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.queries).toHaveLength(appended);
  });
  it('rolls back a failed terminal append, preserves ALLOWED and never retries an uncertain write', async () => {
    const f = databaseFixture(undefined, true);
    const download = await f.port.createCandidateDownload({
      context,
      reference,
      assetId,
    });
    await expect(
      f.port.appendCandidateOriginalOutcome(
        download.outcomeReceipt,
        completedOutcome(),
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(
      f.port.appendCandidateOriginalOutcome(
        download.outcomeReceipt,
        completedOutcome(),
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(
      f.queries.filter((q) =>
        q.text.includes('data.candidate-original.outcome */'),
      ),
    ).toHaveLength(1);
    expect(
      f.queries.filter((q) =>
        q.text.includes('data.candidate-original.audit */'),
      ),
    ).toHaveLength(1);
    expect(f.queries.at(-1)?.text).toBe('ROLLBACK');
    expect(f.queries.some((q) => /update|delete/i.test(q.text))).toBe(false);
  });
});
