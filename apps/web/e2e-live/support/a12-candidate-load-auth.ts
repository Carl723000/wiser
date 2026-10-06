import { createHash } from 'node:crypto';
import {
  AuthorizedContextSchema,
  PlatformPurposeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import { CandidateLoadTransportError } from './a12-candidate-load-driver.ts';

export interface CandidateLoadAuthClient {
  readonly auth: {
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<{
      readonly data: {
        readonly session: { readonly access_token?: unknown } | null;
      } | null;
      readonly error: unknown;
    }>;
    getClaims(token: string): Promise<{
      readonly data: { readonly claims?: unknown } | null;
      readonly error: unknown;
    }>;
    getSession(): Promise<{
      readonly data: {
        readonly session: { readonly access_token?: unknown } | null;
      } | null;
      readonly error: unknown;
    }>;
  };
}

export interface CandidateLoadAuthClientOptions {
  readonly auth: {
    readonly autoRefreshToken: false;
    readonly detectSessionInUrl: false;
    readonly persistSession: false;
  };
  readonly global: { readonly fetch: typeof fetch };
}

export interface CandidateLoadMeInput {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
}

export interface CandidateLoadAuthOptions {
  readonly authOrigin: string;
  readonly taskAuthPort: number;
  readonly publishableKey: string;
  readonly credentials: { readonly email: string; readonly password: string };
  readonly tenantId: string;
  readonly projectId: string;
  readonly purpose: string;
  /** Inject the installed Supabase createClient; never a cookie-bound client. */
  readonly createClient: (
    origin: string,
    publishableKey: string,
    options: CandidateLoadAuthClientOptions,
  ) => CandidateLoadAuthClient | Promise<CandidateLoadAuthClient>;
  readonly authFetch: typeof fetch;
  /** Existing GET /api/platform/v1/me transport, owned by the admitted runtime. */
  readonly readMe: (input: CandidateLoadMeInput) => Promise<{
    readonly status: number;
    readonly body: unknown;
  }>;
  readonly now?: () => Date;
}

export interface CandidateLoadAuthSummary {
  readonly identityDigest: string;
  readonly authorityDigest: string;
  readonly claimsVerified: true;
  readonly sessionTokenMatched: true;
  readonly identityMatched: true;
  readonly necessaryCandidateScopes: true;
  readonly maintainerScope: boolean;
  readonly reviewerScope: boolean;
  /** /me omits resourceAccess, delegation and expiry; it is not full eligibility. */
  readonly candidateAuthority: 'requires-current-candidate-get';
}

export interface CandidateLoadAuthCondition {
  readonly accessToken: () => Promise<string>;
  readonly summary: CandidateLoadAuthSummary;
}

export interface CandidateLoadAuthGuard {
  readonly verifyCondition: () => Promise<CandidateLoadAuthCondition>;
  readonly close: () => void;
}

type Failure =
  | 'configuration'
  | 'authentication'
  | 'denied'
  | 'changed'
  | 'invalid'
  | 'unavailable'
  | 'closed';

const FAILURES: readonly Failure[] = [
  'configuration',
  'authentication',
  'denied',
  'changed',
  'invalid',
  'unavailable',
  'closed',
];

function checkedFailure(value: unknown): Failure {
  for (const kind of FAILURES) if (value === kind) return kind;
  return 'invalid';
}

export class CandidateLoadAuthError extends Error {
  readonly kind: Failure;
  constructor(kind: Failure) {
    super('A12 condition authentication could not be verified.');
    this.name = 'CandidateLoadAuthError';
    this.kind = checkedFailure(kind);
    Object.defineProperty(this, 'kind', {
      value: this.kind,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

function failureKind(error: unknown): Failure {
  try {
    if (error instanceof CandidateLoadAuthError)
      return checkedFailure(
        Object.getOwnPropertyDescriptor(error, 'kind')?.value,
      );
  } catch {
    /* discard untrusted prototype/descriptor errors */
  }
  return 'invalid';
}

function fail(kind: Failure): never {
  throw new CandidateLoadAuthError(kind);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dataFields(value: unknown): Record<string, unknown> | null {
  if (record(value) === null) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function tokenPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return null;
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== payload) return null;
    return record(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateOptions(rawOptions: CandidateLoadAuthOptions): {
  readonly origin: string;
  readonly options: CandidateLoadAuthOptions;
} {
  try {
    const fields = dataFields(rawOptions);
    const credentialFields =
      fields === null ? null : dataFields(fields.credentials);
    if (fields === null || credentialFields === null) fail('configuration');
    const options = fields as unknown as CandidateLoadAuthOptions;
    const credentials =
      credentialFields as unknown as CandidateLoadAuthOptions['credentials'];
    const origin = new URL(options.authOrigin);
    const key = options.publishableKey;
    if (
      !Number.isSafeInteger(options.taskAuthPort) ||
      options.taskAuthPort < 1 ||
      options.taskAuthPort > 65_535 ||
      origin.origin !== `http://127.0.0.1:${options.taskAuthPort}` ||
      (options.authOrigin !== origin.origin &&
        options.authOrigin !== `${origin.origin}/`) ||
      !PlatformUuidSchema.safeParse(options.tenantId).success ||
      !PlatformUuidSchema.safeParse(options.projectId).success ||
      !PlatformPurposeSchema.safeParse(options.purpose).success ||
      typeof key !== 'string' ||
      key.length > 16_384 ||
      (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) &&
        tokenPayload(key)?.role !== 'anon') ||
      typeof credentials.email !== 'string' ||
      credentials.email.length > 320 ||
      !/^[^\s@]+@[^\s@]+$/.test(credentials.email) ||
      typeof credentials.password !== 'string' ||
      credentials.password.length === 0 ||
      credentials.password.length > 4_096 ||
      typeof options.createClient !== 'function' ||
      typeof options.authFetch !== 'function' ||
      typeof options.readMe !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function')
    )
      fail('configuration');
    const fixed: CandidateLoadAuthOptions = Object.freeze({
      authOrigin: origin.origin,
      taskAuthPort: options.taskAuthPort,
      publishableKey: key,
      credentials: Object.freeze({
        email: credentials.email,
        password: credentials.password,
      }),
      tenantId: options.tenantId,
      projectId: options.projectId,
      purpose: options.purpose,
      createClient: options.createClient,
      authFetch: options.authFetch,
      readMe: options.readMe,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { origin: origin.origin, options: fixed };
  } catch {
    return fail('configuration');
  }
}

function restrictedAuthFetch(
  origin: string,
  transport: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    let url: URL;
    try {
      url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
    } catch {
      return fail('configuration');
    }
    if (
      url.origin !== origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      ![
        '/auth/v1/token',
        '/auth/v1/user',
        '/auth/v1/.well-known/jwks.json',
      ].includes(url.pathname)
    )
      fail('configuration');
    // getSession may implicitly refresh even with autoRefreshToken:false.
    // Block that request and reject any changed token; decoding is not verification.
    if (
      url.pathname === '/auth/v1/token' &&
      (url.searchParams.getAll('grant_type').length !== 1 ||
        url.searchParams.get('grant_type') !== 'password')
    )
      fail('authentication');
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== (url.pathname === '/auth/v1/token' ? 'POST' : 'GET'))
      fail('configuration');
    let response: Response;
    try {
      response = await transport(input, { ...init, redirect: 'error' });
    } catch {
      return fail('authentication');
    }
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      try {
        await response.body?.cancel();
      } catch {
        /* discard disposal errors */
      }
      fail('authentication');
    }
    return response;
  };
}

const ME_FIELDS = [
  'actorType',
  'actorId',
  'tenantId',
  'projectId',
  'roles',
  'scopes',
  'purpose',
  'maxSecurityLevel',
  'authzVersion',
] as const;

/** Test-side only: all Auth and /me work completes before measured requests. */
export async function authenticateCandidateLoad(
  rawOptions: CandidateLoadAuthOptions,
): Promise<CandidateLoadAuthGuard> {
  const { origin, options } = validateOptions(rawOptions);
  const { tenantId, projectId, purpose, readMe } = options;
  const now = options.now ?? (() => new Date());
  let client: CandidateLoadAuthClient | null;
  try {
    client = await options.createClient(origin, options.publishableKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { fetch: restrictedAuthFetch(origin, options.authFetch) },
    });
  } catch {
    return fail('configuration');
  }
  let pinnedToken = '';
  let closed = false;
  let verifying = false;
  let generation = 0;
  let subject = '';
  let sessionId = '';
  let expiresAt = 0;
  let baseline: CandidateLoadAuthSummary | null = null;

  function close(): void {
    closed = true;
    generation += 1;
    pinnedToken = '';
    subject = '';
    sessionId = '';
    expiresAt = 0;
    baseline = null;
    client = null;
  }

  function assertOpen(): void {
    if (closed || client === null) fail('closed');
  }

  async function verify(): Promise<CandidateLoadAuthSummary> {
    assertOpen();
    if (verifying) {
      close();
      fail('changed');
    }
    verifying = true;
    generation += 1;
    try {
      const current = client!;
      let claimsResult: Awaited<
        ReturnType<CandidateLoadAuthClient['auth']['getClaims']>
      >;
      try {
        claimsResult = await current.auth.getClaims(pinnedToken);
      } catch {
        return fail('authentication');
      }
      assertOpen();
      const claims = record(claimsResult.data?.claims);
      const time = now().valueOf();
      if (
        claimsResult.error !== null ||
        claims === null ||
        claims.role !== 'authenticated' ||
        claims.client_id !== undefined ||
        !PlatformUuidSchema.safeParse(claims.sub).success ||
        !PlatformUuidSchema.safeParse(claims.session_id).success ||
        typeof claims.exp !== 'number' ||
        !Number.isSafeInteger(claims.exp) ||
        !Number.isFinite(time) ||
        !Number.isFinite(claims.exp * 1_000) ||
        claims.exp * 1_000 <= time
      )
        fail('authentication');
      const payload = tokenPayload(pinnedToken);
      if (
        payload === null ||
        payload.sub !== claims.sub ||
        payload.session_id !== claims.session_id ||
        payload.exp !== claims.exp ||
        payload.role !== 'authenticated' ||
        payload.client_id !== undefined
      )
        fail('authentication');
      let sessionResult: Awaited<
        ReturnType<CandidateLoadAuthClient['auth']['getSession']>
      >;
      try {
        sessionResult = await current.auth.getSession();
      } catch {
        return fail('authentication');
      }
      assertOpen();
      if (
        sessionResult.error !== null ||
        sessionResult.data?.session?.access_token !== pinnedToken
      )
        fail('authentication');
      let result: Awaited<ReturnType<CandidateLoadAuthOptions['readMe']>>;
      try {
        result = await readMe({
          accessToken: pinnedToken,
          tenantId,
          projectId,
          purpose,
        });
      } catch {
        return fail('unavailable');
      }
      assertOpen();
      if (result.status === 401 || result.status === 403) fail('denied');
      if (result.status !== 200) fail('unavailable');
      const body = record(result.body);
      if (
        body === null ||
        Object.keys(body).length !== ME_FIELDS.length ||
        !ME_FIELDS.every((key) => Object.hasOwn(body, key))
      )
        fail('invalid');
      const authorization = AuthorizedContextSchema.safeParse({
        tenantId: body.tenantId,
        projectId: body.projectId,
        roles: body.roles,
        scopes: body.scopes,
        purpose: body.purpose,
        maxSecurityLevel: body.maxSecurityLevel,
        authzVersion: body.authzVersion,
      });
      if (
        !authorization.success ||
        !PlatformUuidSchema.safeParse(body.actorId).success
      )
        fail('invalid');
      if (
        body.actorType !== 'human' ||
        body.actorId !== claims.sub ||
        body.tenantId !== tenantId ||
        body.projectId !== projectId ||
        body.purpose !== purpose ||
        (baseline !== null &&
          (claims.sub !== subject || claims.session_id !== sessionId))
      )
        fail('changed');
      const scopes = authorization.data.scopes;
      const maintainerScope =
        scopes.includes('data.operation.read') &&
        scopes.includes('data.ingestion.write');
      const reviewerScope =
        scopes.includes('data.operation.read') &&
        scopes.includes('data.publish');
      if (!maintainerScope && !reviewerScope) fail('denied');
      const summary: CandidateLoadAuthSummary = Object.freeze({
        identityDigest: digest([
          claims.sub,
          claims.session_id,
          tenantId,
          projectId,
          purpose,
        ]),
        authorityDigest: digest([
          [...authorization.data.roles].sort(),
          [...scopes].sort(),
          authorization.data.maxSecurityLevel,
          authorization.data.authzVersion,
        ]),
        claimsVerified: true,
        sessionTokenMatched: true,
        identityMatched: true,
        necessaryCandidateScopes: true,
        maintainerScope,
        reviewerScope,
        candidateAuthority: 'requires-current-candidate-get',
      });
      if (
        baseline !== null &&
        (baseline.identityDigest !== summary.identityDigest ||
          baseline.authorityDigest !== summary.authorityDigest)
      )
        fail('changed');
      subject = claims.sub as string;
      sessionId = claims.session_id as string;
      expiresAt = claims.exp * 1_000;
      const deliveryTime = now().valueOf();
      if (!Number.isFinite(deliveryTime) || expiresAt <= deliveryTime)
        fail('authentication');
      baseline ??= summary;
      return summary;
    } catch (error) {
      close();
      return fail(failureKind(error));
    } finally {
      verifying = false;
    }
  }

  try {
    const login = await client.auth.signInWithPassword({
      email: options.credentials.email,
      password: options.credentials.password,
    });
    const token = login.data?.session?.access_token;
    if (
      login.error !== null ||
      typeof token !== 'string' ||
      token.length === 0 ||
      Buffer.byteLength(token) > 16_384
    )
      fail('authentication');
    pinnedToken = token;
  } catch {
    close();
    return fail('authentication');
  }
  await verify();
  return Object.freeze({
    async verifyCondition() {
      const summary = await verify();
      const conditionGeneration = generation;
      return Object.freeze({
        summary,
        async accessToken() {
          // Preserve the measured transport's terminal classifications. The
          // condition precheck still uses CandidateLoadAuthError above.
          if (closed || client === null)
            throw new CandidateLoadTransportError('cancelled');
          if (conditionGeneration !== generation)
            throw new CandidateLoadTransportError('stale');
          try {
            const time = now().valueOf();
            if (!Number.isFinite(time) || expiresAt <= time)
              fail('authentication');
          } catch {
            close();
            throw new CandidateLoadTransportError('denied');
          }
          return Promise.resolve(pinnedToken);
        },
      });
    },
    close,
  });
}
