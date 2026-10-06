import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  authenticateCandidateLoad,
  CandidateLoadAuthError,
  type CandidateLoadAuthClientOptions,
  type CandidateLoadMeInput,
} from '../../apps/web/e2e-live/support/a12-candidate-load-auth.ts';
import {
  CandidateLoadTransportError,
  canonicalLoadContent,
  pageFingerprint,
  runCandidateLoadCondition,
  type FrozenCandidateDataset,
} from '../../apps/web/e2e-live/support/a12-candidate-load-driver.ts';
import { createCandidateLoadHttpAdapter } from '../../apps/web/e2e-live/support/a12-candidate-load-http.ts';
import { traversalContentDigest } from '../../apps/web/e2e-live/support/a12-candidate-load-traversal.ts';
import {
  IngestionCandidateAssetPageSchema,
  IngestionCandidateBatchSchema,
} from '../../packages/data-contracts/src/index.ts';

const subject = '10000000-0000-4000-8000-000000000001';
const sessionId = '10000000-0000-4000-8000-000000000002';
const tenantId = '10000000-0000-4000-8000-000000000003';
const projectId = '10000000-0000-4000-8000-000000000004';
const otherId = '10000000-0000-4000-8000-000000000005';
const privateSentinel = 'SYNTHETIC_PRIVATE_AUTH_SENTINEL';
const nowMs = Date.parse('2026-10-06T00:00:00Z');
const claims = {
  sub: subject,
  session_id: sessionId,
  role: 'authenticated',
  exp: nowMs / 1000 + 3600,
};
const tokenFor = (value: unknown, signature = privateSentinel) =>
  `e30.${Buffer.from(JSON.stringify(value)).toString('base64url')}.${signature}`;
const token = tokenFor(claims);
const me = {
  actorType: 'human',
  actorId: subject,
  tenantId,
  projectId,
  purpose: 'research',
  roles: ['data-maintainer'],
  scopes: ['data.operation.read', 'data.ingestion.write'],
  maxSecurityLevel: 'L3_CONFIDENTIAL',
  authzVersion: 1,
};

function combinationFixture() {
  const reference = {
    kind: 'ingestion-candidate' as const,
    ingestionId: subject,
    processingBatchId: sessionId,
    reviewHash: 'a'.repeat(64),
  };
  const batch = IngestionCandidateBatchSchema.parse({
    reference,
    status: 'READY',
    parserVersion: 'auth-combination-synthetic',
    createdAt: '2026-10-06T00:00:00Z',
    assets: [
      {
        assetId: otherId,
        status: 'READY',
        sourceHash: 'b'.repeat(64),
        recordCount: 0,
        featureCount: 0,
        reason: null,
      },
    ],
  });
  const page = IngestionCandidateAssetPageSchema.parse({
    ...batch,
    totalAssetCount: 1,
    knownRecordCount: 0,
    knownFeatureCount: 0,
    unknownAssetCount: 0,
    nextCursor: null,
  });
  const fingerprint = (value: unknown) =>
    createHash('sha256')
      .update(JSON.stringify(canonicalLoadContent(value)))
      .digest('hex');
  // Independent synthetic literals only: the track label is not real S10 admission.
  const frozen: FrozenCandidateDataset = {
    dataset: 'SYNTHETIC-S10',
    provenance: {
      kind: 'standard-intake-http',
      receiptSha256: 'c'.repeat(64),
      inventorySha256: 'd'.repeat(64),
    },
    batch,
    materials: [
      {
        assetId: otherId,
        columns: [],
        recordsDigest: traversalContentDigest('records', [], [], fingerprint),
        geometryDigest: traversalContentDigest('geometry', [], [], fingerprint),
      },
    ],
    firstPages: (['get', 'records', 'geometry'] as const).flatMap((action) =>
      ([50, 200] as const).map((first) => ({
        action,
        first,
        assetId: action === 'get' ? null : otherId,
        digest:
          action === 'get'
            ? pageFingerprint(page, fingerprint)
            : fingerprint([]),
      })),
    ),
  };
  return { frozen, page, fingerprint };
}

function fixture() {
  let clock = nowMs;
  const state = {
    loginToken: token,
    sessionToken: token,
    claims: { ...claims },
    me: { ...me, roles: [...me.roles], scopes: [...me.scopes] },
  };
  const auth = {
    signInWithPassword: vi.fn(
      (_credentials: { email: string; password: string }) =>
        Promise.resolve({
          data: { session: { access_token: state.loginToken } },
          error: null,
        }),
    ),
    getClaims: vi.fn((_token: string) =>
      Promise.resolve({
        data: { claims: state.claims },
        error: null,
      }),
    ),
    getSession: vi.fn(() =>
      Promise.resolve({
        data: { session: { access_token: state.sessionToken } },
        error: null,
      }),
    ),
  };
  const createClient = vi.fn(
    (
      _origin: string,
      _key: string,
      _options: CandidateLoadAuthClientOptions,
    ) => ({ auth }),
  );
  const readMe = vi.fn((_input: CandidateLoadMeInput) =>
    Promise.resolve({ status: 200, body: state.me }),
  );
  const authFetch = vi.fn(
    (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => Promise.resolve(new Response('{}', { status: 200 })),
  );
  const options = {
    authOrigin: 'http://127.0.0.1:57321',
    taskAuthPort: 57321,
    publishableKey: 'sb_publishable_synthetic_only',
    credentials: { email: 'synthetic@example.test', password: privateSentinel },
    tenantId,
    projectId,
    purpose: 'research',
    createClient,
    authFetch,
    readMe,
    now: () => new Date(clock),
  };
  return {
    state,
    auth,
    createClient,
    readMe,
    authFetch,
    options,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

async function safeFailure(
  work: () => Promise<unknown>,
  kind: string,
  name = 'CandidateLoadAuthError',
) {
  const error: unknown = await work().then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(Error);
  if (name === 'CandidateLoadTransportError') {
    expect(error).toBeInstanceOf(CandidateLoadTransportError);
    expect(error).toMatchObject({ kind });
  } else expect(error).toMatchObject({ name, kind });
  expect(String(error)).not.toContain(privateSentinel);
  expect(JSON.stringify(error)).not.toContain(privateSentinel);
  expect(error).not.toHaveProperty('cause');
}

describe(
  'A12 condition authentication guard with fakes only',
  { concurrent: false },
  () => {
    it('authenticates once and verifies fresh claims, exact session token and me before each condition', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const first = await guard.verifyCondition();
      const callsBeforeMeasurement = [
        f.auth.getClaims.mock.calls.length,
        f.auth.getSession.mock.calls.length,
        f.readMe.mock.calls.length,
      ];
      expect(await first.accessToken()).toBe(token);
      expect(await first.accessToken()).toBe(token);
      expect([
        f.auth.getClaims.mock.calls.length,
        f.auth.getSession.mock.calls.length,
        f.readMe.mock.calls.length,
      ]).toEqual(callsBeforeMeasurement);
      const second = await guard.verifyCondition();
      expect(await second.accessToken()).toBe(token);
      expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
      expect(f.auth.getClaims.mock.calls.length).toBe(3);
      expect(f.auth.getSession.mock.calls.length).toBe(3);
      expect(f.readMe.mock.calls.length).toBe(3);
      expect(f.auth.getClaims).toHaveBeenCalledWith(token);
      expect(f.readMe).toHaveBeenCalledWith({
        accessToken: token,
        tenantId,
        projectId,
        purpose: 'research',
      });
      expect(f.createClient.mock.calls[0]).toEqual([
        f.options.authOrigin,
        f.options.publishableKey,
        {
          auth: {
            autoRefreshToken: false,
            detectSessionInUrl: false,
            persistSession: false,
          },
          global: { fetch: f.createClient.mock.calls[0]![2].global.fetch },
        },
      ]);
      guard.close();
    });

    it('returns only sanitized hashes and necessary-scope booleans, retaining the full-authority boundary', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const condition = await guard.verifyCondition();
      expect(condition.summary).toEqual({
        identityDigest: createHash('sha256')
          .update(
            JSON.stringify([
              subject,
              sessionId,
              tenantId,
              projectId,
              'research',
            ]),
          )
          .digest('hex'),
        authorityDigest: condition.summary.authorityDigest,
        claimsVerified: true,
        sessionTokenMatched: true,
        identityMatched: true,
        necessaryCandidateScopes: true,
        maintainerScope: true,
        reviewerScope: false,
        candidateAuthority: 'requires-current-candidate-get',
      });
      expect(condition.summary.authorityDigest).toMatch(/^[0-9a-f]{64}$/);
      const serialized = JSON.stringify({ guard, condition });
      for (const sensitive of [
        subject,
        sessionId,
        tenantId,
        projectId,
        token,
        privateSentinel,
        f.options.credentials.email,
      ])
        expect(serialized).not.toContain(sensitive);
      expect(Object.isFrozen(condition)).toBe(true);
      expect(Object.isFrozen(condition.summary)).toBe(true);
    });

    it.each([
      { authOrigin: 'https://remote.example.test' },
      { authOrigin: 'http://127.0.0.1:57322' },
      { authOrigin: 'http://localhost:57321' },
      { authOrigin: 'http://private@127.0.0.1:57321' },
      { authOrigin: 'http://127.0.0.1:57321/auth/v1' },
      { authOrigin: 'http://127.0.0.1:57321/?secret=private' },
      { authOrigin: 'http://127.0.0.1:57321/#private' },
      { tenantId: 'invalid' },
      { projectId: 'invalid' },
      { purpose: 'private purpose' },
      { publishableKey: tokenFor({ role: 'service_role' }) },
    ])(
      'rejects invalid configuration before credential dispatch %#',
      async (override) => {
        const f = fixture();
        await safeFailure(
          () => authenticateCandidateLoad({ ...f.options, ...override }),
          'configuration',
        );
        expect(f.createClient).not.toHaveBeenCalled();
        expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
      },
    );

    it('requires sign-in, verified claims and stored session to carry the same complete token', async () => {
      const f = fixture();
      f.state.sessionToken = tokenFor(claims, 'different-signature');
      await safeFailure(
        () => authenticateCandidateLoad(f.options),
        'authentication',
      );
      expect(f.readMe).not.toHaveBeenCalled();
    });

    it.each([
      { role: 'anon' },
      { sub: otherId },
      { session_id: otherId },
      { exp: claims.exp + 1 },
      { exp: nowMs / 1000 },
      { client_id: otherId },
    ])(
      'rejects invalid, OAuth or mismatched verified claims %#',
      async (patch) => {
        const f = fixture();
        Object.assign(f.state.claims, patch);
        await safeFailure(
          () => authenticateCandidateLoad(f.options),
          'authentication',
        );
        expect(f.readMe).not.toHaveBeenCalled();
      },
    );

    it.each([
      'actorId',
      'tenantId',
      'projectId',
      'purpose',
      'actorType',
    ] as const)('rejects me identity drift in %s', async (key) => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const condition = await guard.verifyCondition();
      f.state.me = {
        ...f.state.me,
        [key]:
          key === 'actorType'
            ? 'agent'
            : key === 'purpose'
              ? 'different'
              : otherId,
      };
      await safeFailure(() => guard.verifyCondition(), 'changed');
      await safeFailure(
        () => condition.accessToken(),
        'cancelled',
        'CandidateLoadTransportError',
      );
      expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
    });

    it('rejects data.operation.read alone while accepting human reviewer scopes as necessary conditions', async () => {
      const f = fixture();
      f.state.me.scopes = ['data.operation.read'];
      await safeFailure(() => authenticateCandidateLoad(f.options), 'denied');
      const reviewer = fixture();
      reviewer.state.me.scopes = ['data.operation.read', 'data.publish'];
      const condition = await (
        await authenticateCandidateLoad(reviewer.options)
      ).verifyCondition();
      expect(condition.summary).toMatchObject({
        maintainerScope: false,
        reviewerScope: true,
        candidateAuthority: 'requires-current-candidate-get',
      });
    });

    it.each(['roles', 'scopes', 'authzVersion', 'maxSecurityLevel'] as const)(
      'invalidates the run on me authority drift in %s',
      async (key) => {
        const f = fixture();
        const guard = await authenticateCandidateLoad(f.options);
        f.state.me = {
          ...f.state.me,
          [key]:
            key === 'roles'
              ? ['other-role']
              : key === 'scopes'
                ? [...me.scopes, 'data.publish']
                : key === 'authzVersion'
                  ? 2
                  : 'L2_RESTRICTED',
        };
        await safeFailure(() => guard.verifyCondition(), 'changed');
        await safeFailure(() => guard.verifyCondition(), 'closed');
      },
    );

    it('compares role and scope sets without treating their order as authority drift', async () => {
      const f = fixture();
      f.state.me.roles = ['data-maintainer', 'data-reviewer'];
      const guard = await authenticateCandidateLoad(f.options);
      f.state.me.scopes.reverse();
      f.state.me.roles.reverse();
      expect(
        (await guard.verifyCondition()).summary.necessaryCandidateScopes,
      ).toBe(true);
    });

    it('never accepts a refreshed token and never relogs in after condition failure', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const condition = await guard.verifyCondition();
      f.state.sessionToken = tokenFor({ ...claims, exp: claims.exp + 3600 });
      await safeFailure(() => guard.verifyCondition(), 'authentication');
      await safeFailure(
        () => condition.accessToken(),
        'cancelled',
        'CandidateLoadTransportError',
      );
      expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
    });

    it('expires a condition token without network calls and discards older condition closures', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const oldCondition = await guard.verifyCondition();
      const condition = await guard.verifyCondition();
      await safeFailure(
        () => oldCondition.accessToken(),
        'stale',
        'CandidateLoadTransportError',
      );
      f.setNow(claims.exp * 1000);
      await safeFailure(
        () => condition.accessToken(),
        'denied',
        'CandidateLoadTransportError',
      );
      await safeFailure(() => guard.verifyCondition(), 'closed');
      expect(f.auth.getSession).toHaveBeenCalledTimes(3);
    });

    it('blocks Supabase implicit refresh and foreign/redirected auth transport before fetch', async () => {
      const f = fixture();
      await authenticateCandidateLoad(f.options);
      const config = f.createClient.mock.calls[0]?.[2] as unknown as {
        global: { fetch: typeof fetch };
      };
      await safeFailure(
        () =>
          config.global.fetch(
            `${f.options.authOrigin}/auth/v1/token?grant_type=refresh_token`,
          ),
        'authentication',
      );
      await safeFailure(
        () =>
          config.global.fetch(
            'https://remote.example.test/auth/v1/token?grant_type=password',
          ),
        'configuration',
      );
      expect(f.authFetch).not.toHaveBeenCalled();
      await config.global.fetch(
        `${f.options.authOrigin}/auth/v1/.well-known/jwks.json`,
      );
      expect(f.authFetch).toHaveBeenCalledWith(
        `${f.options.authOrigin}/auth/v1/.well-known/jwks.json`,
        { redirect: 'error' },
      );
      f.authFetch.mockResolvedValueOnce(new Response(null, { status: 302 }));
      await safeFailure(
        () => config.global.fetch(`${f.options.authOrigin}/auth/v1/user`),
        'authentication',
      );
      expect(f.authFetch).toHaveBeenCalledTimes(2);
    });

    it.each(['login', 'claims', 'session', 'me'] as const)(
      'sanitizes raw %s exceptions and does not retry',
      async (phase) => {
        const f = fixture();
        const error = new Error(privateSentinel, { cause: privateSentinel });
        if (phase === 'login')
          f.auth.signInWithPassword.mockRejectedValueOnce(error);
        if (phase === 'claims') f.auth.getClaims.mockRejectedValueOnce(error);
        if (phase === 'session') f.auth.getSession.mockRejectedValueOnce(error);
        if (phase === 'me') f.readMe.mockRejectedValueOnce(error);
        await safeFailure(
          () => authenticateCandidateLoad(f.options),
          phase === 'me' ? 'unavailable' : 'authentication',
        );
        expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
      },
    );

    it.each([401, 403])(
      'does not parse a denied me body or reuse prior identity (%s)',
      async (status) => {
        const f = fixture();
        const guard = await authenticateCandidateLoad(f.options);
        const condition = await guard.verifyCondition();
        f.readMe.mockResolvedValueOnce({
          status,
          body: {
            get actorId() {
              throw new Error(privateSentinel);
            },
          },
        } as never);
        await safeFailure(() => guard.verifyCondition(), 'denied');
        await safeFailure(
          () => condition.accessToken(),
          'cancelled',
          'CandidateLoadTransportError',
        );
        expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses an expanded or malformed me body rather than inventing candidate eligibility', async () => {
      const f = fixture();
      Object.assign(f.state.me, {
        resourceAccess: { scope: { mode: 'managed' } },
      });
      await safeFailure(() => authenticateCandidateLoad(f.options), 'invalid');
    });

    it('close invalidates outstanding condition closures without remote sign-out or token export', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      const condition = await guard.verifyCondition();
      guard.close();
      guard.close();
      await safeFailure(
        () => condition.accessToken(),
        'cancelled',
        'CandidateLoadTransportError',
      );
      await safeFailure(() => guard.verifyCondition(), 'closed');
    });
    it('allows only the installed password/user/JWKS Auth paths and their methods', async () => {
      const f = fixture();
      await authenticateCandidateLoad(f.options);
      const transport = f.createClient.mock.calls[0]![2].global.fetch;
      for (const path of [
        '/auth/v1/admin/users',
        '/auth/v1/signup',
        '/auth/v1/anything',
      ]) {
        await safeFailure(
          () => transport(`${f.options.authOrigin}${path}`),
          'configuration',
        );
      }
      await safeFailure(
        () =>
          transport(`${f.options.authOrigin}/auth/v1/user`, { method: 'POST' }),
        'configuration',
      );
      await safeFailure(
        () =>
          transport(
            `${f.options.authOrigin}/auth/v1/token?grant_type=password`,
          ),
        'configuration',
      );
      expect(f.authFetch).not.toHaveBeenCalled();
      await transport(
        `${f.options.authOrigin}/auth/v1/token?grant_type=password`,
        { method: 'POST' },
      );
      expect(f.authFetch).toHaveBeenCalledTimes(1);
    });

    it('sanitizes a clock exception and permanently invalidates its condition', async () => {
      const f = fixture();
      let throwClock = false;
      const guard = await authenticateCandidateLoad({
        ...f.options,
        now: () => {
          if (throwClock) throw new Error(privateSentinel);
          return new Date(nowMs);
        },
      });
      const condition = await guard.verifyCondition();
      throwClock = true;
      await safeFailure(
        () => condition.accessToken(),
        'denied',
        'CandidateLoadTransportError',
      );
      await safeFailure(() => guard.verifyCondition(), 'closed');
    });

    it('closes the run when overlapping condition verification is attempted', async () => {
      const f = fixture();
      const guard = await authenticateCandidateLoad(f.options);
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.auth.getClaims.mockImplementationOnce(async () => {
        await pending;
        return { data: { claims: f.state.claims }, error: null };
      });
      const first = guard.verifyCondition();
      await safeFailure(() => guard.verifyCondition(), 'changed');
      release!();
      await safeFailure(() => first, 'closed');
      await safeFailure(() => guard.verifyCondition(), 'closed');
    });
    it.each(['expiry', 'generation', 'close'] as const)(
      'actual guard→loopback HTTP→driver stops %s after five warmups and retains started C1/C4 attempts',
      async (change) => {
        for (const concurrency of [1, 4] as const) {
          const f = fixture();
          const guard = await authenticateCandidateLoad(f.options);
          const condition = await guard.verifyCondition();
          const { frozen, page, fingerprint } = combinationFixture();
          let hits = 0;
          let headersMatched = true;
          const server = createServer((req, res) => {
            hits += 1;
            headersMatched &&=
              req.headers.authorization === `Bearer ${token}` &&
              req.headers['x-wiser-tenant-id'] === tenantId &&
              req.headers['x-wiser-project-id'] === projectId &&
              req.headers['x-wiser-purpose'] === 'research';
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(page));
          });
          // This test owns the listener first, so it cannot send to an existing service.
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          const address = server.address();
          if (address === null || typeof address === 'string')
            throw new Error(
              'Task-owned synthetic listener address is unavailable.',
            );
          const adapter = createCandidateLoadHttpAdapter({
            apiOrigin: `http://127.0.0.1:${address.port}`,
            taskApiPort: address.port,
            tenantId,
            projectId,
            purpose: 'research',
            accessToken: condition.accessToken,
          });
          let completed = 0;
          let started = 0;
          try {
            const result = await runCandidateLoadCondition(
              frozen,
              {
                dataset: 'SYNTHETIC-S10',
                action: 'get',
                first: 200,
                concurrency,
              },
              {
                send: async (input) => {
                  started += 1;
                  const reply = await adapter.send(input);
                  if (++completed === 5) {
                    if (change === 'expiry') f.setNow(claims.exp * 1000);
                    if (change === 'generation') await guard.verifyCondition();
                    if (change === 'close') guard.close();
                  }
                  return reply;
                },
                now: () => performance.now(),
                fingerprint,
              },
            );
            expect(result.status).toBe('failed');
            expect(result.warmup).toHaveLength(5);
            expect(
              result.warmup.every((sample) => sample.outcome === 'completed'),
            ).toBe(true);
            expect(result.measured).toHaveLength(concurrency);
            const expected =
              change === 'expiry'
                ? 'denied'
                : change === 'generation'
                  ? 'stale'
                  : 'cancelled';
            expect(result.measured[0]?.outcome).toBe(expected);
            expect(
              result.measured.every(
                (sample) =>
                  (sample.outcome === expected ||
                    (change === 'expiry' && sample.outcome === 'cancelled')) &&
                  sample.wireBytes === null &&
                  sample.dtoBytes === null,
              ),
            ).toBe(true);
            if (change === 'expiry')
              expect(
                result.measured.filter((sample) => sample.outcome === 'denied'),
              ).toHaveLength(1);
            expect(started).toBe(5 + concurrency);
            expect(hits).toBe(5);
            expect(headersMatched).toBe(true);
            expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
            expect(adapter.diagnostics().activeRequests).toBe(0);
            const serialized = JSON.stringify(result);
            for (const sensitive of [
              privateSentinel,
              token,
              subject,
              sessionId,
              tenantId,
              projectId,
            ])
              expect(serialized).not.toContain(sensitive);
          } finally {
            adapter.close();
            guard.close();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
      },
    );
    it.each(['options', 'credentials'] as const)(
      'rejects %s accessors without evaluating private getters or dispatching',
      async (where) => {
        const f = fixture();
        let reads = 0;
        if (where === 'options')
          Object.defineProperty(f.options, 'readMe', {
            get() {
              if (++reads === 1) return f.readMe;
              throw new Error(privateSentinel);
            },
          });
        else
          Object.defineProperty(f.options.credentials, 'password', {
            get() {
              reads += 1;
              throw new Error(privateSentinel);
            },
          });
        await safeFailure(
          () => authenticateCandidateLoad(f.options),
          'configuration',
        );
        expect(reads).toBe(0);
        expect(f.createClient).not.toHaveBeenCalled();
        expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
        expect(f.readMe).not.toHaveBeenCalled();
      },
    );

    it('pins validated credential and context inputs before an injected factory can mutate originals', async () => {
      const f = fixture();
      f.createClient.mockImplementationOnce(() => {
        f.options.credentials.password = 'modified-after-validation';
        f.options.tenantId = otherId;
        f.options.readMe = vi.fn(() =>
          Promise.reject(new Error(privateSentinel)),
        );
        return { auth: f.auth };
      });
      const guard = await authenticateCandidateLoad(f.options);
      const condition = await guard.verifyCondition();
      expect(await condition.accessToken()).toBe(token);
      expect(f.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'synthetic@example.test',
        password: privateSentinel,
      });
      expect(f.readMe).toHaveBeenCalledWith({
        accessToken: token,
        tenantId,
        projectId,
        purpose: 'research',
      });
    });
    it('keeps Auth failure kinds immutable and sanitizes out-of-enum constructor values', () => {
      const error = new CandidateLoadAuthError('invalid');
      expect(Reflect.set(error, 'kind', privateSentinel)).toBe(false);
      expect(error.kind).toBe('invalid');
      const invalid = new CandidateLoadAuthError(privateSentinel as 'invalid');
      expect(invalid.kind).toBe('invalid');
      expect(JSON.stringify(invalid)).not.toContain(privateSentinel);
    });

    it('does not copy a private runtime failure kind from a branded clock exception', async () => {
      const f = fixture();
      const error = new CandidateLoadAuthError('invalid');
      Reflect.set(error, 'kind', privateSentinel);
      error.message = privateSentinel;
      await safeFailure(
        () =>
          authenticateCandidateLoad({
            ...f.options,
            now: () => {
              throw error;
            },
          }),
        'invalid',
      );
    });
  },
);
