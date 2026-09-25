import {
  PlatformAgentAuthorizationIdSchema,
  PlatformAgentAuthorizeCommandSchema,
  PlatformAgentAuthorizationViewSchema,
  PlatformUuidSchema,
  type PlatformAgentAuthorizationView,
  type PlatformAgentAuthorizeCommand,
} from '@wiser/platform-contracts';

export type AgentConsentFailure =
  'invalid-request' | 'mismatch' | 'not-allowed' | 'unavailable';

export class AgentConsentError extends Error {
  constructor(readonly reason: AgentConsentFailure) {
    super(reason);
    this.name = 'AgentConsentError';
  }
}

interface OAuthResult {
  readonly data: unknown;
  readonly error: unknown;
}

export interface AgentConsentDependencies {
  readonly oauth: {
    readonly getAuthorizationDetails: (
      authorizationId: string,
    ) => Promise<OAuthResult>;
    readonly approveAuthorization: (
      authorizationId: string,
      options: { readonly skipBrowserRedirect: true },
    ) => Promise<OAuthResult>;
    readonly denyAuthorization: (
      authorizationId: string,
      options: { readonly skipBrowserRedirect: true },
    ) => Promise<OAuthResult>;
  };
  readonly inspect: (
    token: string,
    authorizationId: string,
  ) => Promise<PlatformAgentAuthorizationView>;
  readonly authorize: (
    token: string,
    command: PlatformAgentAuthorizeCommand,
    idempotencyKey: string,
  ) => Promise<{ readonly connectionId: string }>;
  readonly createIdempotencyKey: () => string;
}

interface OAuthDetails {
  readonly authorization_id: string;
  readonly client: { readonly id: string; readonly name: string };
  readonly redirect_uri: string;
  readonly scope: string;
}

export type AgentConsentRequest =
  | { readonly kind: 'already-authorized'; readonly redirectUrl: string }
  | {
      readonly kind: 'request';
      readonly authorizationId: string;
      readonly clientName: string;
      readonly redirectUri: string;
      readonly scopes: readonly string[];
      readonly projects: PlatformAgentAuthorizationView['projects'];
    };

export type AgentConsentDecision =
  | { readonly authorizationId: string; readonly decision: 'deny' }
  | ({ readonly decision: 'approve' } & PlatformAgentAuthorizeCommand);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function callbackUrl(value: unknown, registered?: string): string {
  if (typeof value !== 'string' || value.length > 4096) {
    throw new AgentConsentError('mismatch');
  }
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new AgentConsentError('mismatch');
  }
  if (
    (target.protocol !== 'https:' && target.protocol !== 'http:') ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new AgentConsentError('mismatch');
  }
  if (registered !== undefined) {
    let expected: URL;
    try {
      expected = new URL(registered);
    } catch {
      throw new AgentConsentError('mismatch');
    }
    if (
      target.origin !== expected.origin ||
      target.pathname !== expected.pathname
    ) {
      throw new AgentConsentError('mismatch');
    }
    for (const key of expected.searchParams.keys()) {
      const required = expected.searchParams.getAll(key);
      const actual = target.searchParams.getAll(key);
      if (required.some((item, index) => actual[index] !== item)) {
        throw new AgentConsentError('mismatch');
      }
    }
  }
  return target.href;
}

function details(value: unknown, authorizationId: string): OAuthDetails {
  const parsed = record(value);
  const client = record(parsed?.['client']);
  if (
    parsed?.['authorization_id'] !== authorizationId ||
    !PlatformUuidSchema.safeParse(client?.['id']).success ||
    typeof client?.['name'] !== 'string' ||
    client['name'].length === 0 ||
    client['name'].length > 1024 ||
    typeof parsed['redirect_uri'] !== 'string' ||
    typeof parsed['scope'] !== 'string' ||
    parsed['scope'].length > 2048
  ) {
    throw new AgentConsentError('mismatch');
  }
  callbackUrl(parsed['redirect_uri']);
  return {
    authorization_id: authorizationId,
    client: { id: client['id'] as string, name: client['name'] },
    redirect_uri: parsed['redirect_uri'],
    scope: parsed['scope'],
  };
}

async function oauthDetails(
  deps: AgentConsentDependencies,
  authorizationId: string,
): Promise<OAuthDetails | { readonly redirectUrl: string }> {
  let result: OAuthResult;
  try {
    result = await deps.oauth.getAuthorizationDetails(authorizationId);
  } catch {
    throw new AgentConsentError('unavailable');
  }
  if (result.error !== null || result.data === null) {
    throw new AgentConsentError('invalid-request');
  }
  const returned = record(result.data);
  if (returned !== null && 'redirect_url' in returned) {
    return { redirectUrl: callbackUrl(returned['redirect_url']) };
  }
  return details(result.data, authorizationId);
}

export async function loadAgentConsent(
  deps: AgentConsentDependencies,
  token: string,
  authorizationId: string,
): Promise<AgentConsentRequest> {
  if (!PlatformAgentAuthorizationIdSchema.safeParse(authorizationId).success) {
    throw new AgentConsentError('invalid-request');
  }
  // Supabase associates this request with the signed-in user before WISER inspects it.
  const request = await oauthDetails(deps, authorizationId);
  if ('redirectUrl' in request) {
    return { kind: 'already-authorized', redirectUrl: request.redirectUrl };
  }
  let response: PlatformAgentAuthorizationView;
  try {
    response = PlatformAgentAuthorizationViewSchema.parse(
      await deps.inspect(token, authorizationId),
    );
  } catch {
    throw new AgentConsentError('not-allowed');
  }
  if (
    response.authorizationId !== authorizationId ||
    response.clientId !== request.client.id ||
    response.redirectUri !== request.redirect_uri ||
    response.clientName !== request.client.name
  ) {
    throw new AgentConsentError('mismatch');
  }
  return {
    kind: 'request',
    authorizationId,
    clientName: response.clientName,
    redirectUri: response.redirectUri,
    scopes: request.scope.split(/\s+/).filter(Boolean),
    projects: response.projects,
  };
}

const securityOrder = [
  'L0_PUBLIC',
  'L1_INTERNAL',
  'L2_RESTRICTED',
  'L3_CONFIDENTIAL',
] as const;

export async function decideAgentConsent(
  deps: AgentConsentDependencies,
  token: string,
  input: AgentConsentDecision,
): Promise<string> {
  const request = await loadAgentConsent(deps, token, input.authorizationId);
  if (request.kind !== 'request') {
    throw new AgentConsentError('invalid-request');
  }
  if (input.decision === 'deny') {
    let result: OAuthResult;
    try {
      result = await deps.oauth.denyAuthorization(input.authorizationId, {
        skipBrowserRedirect: true,
      });
    } catch {
      throw new AgentConsentError('unavailable');
    }
    if (result.error !== null) throw new AgentConsentError('unavailable');
    return callbackUrl(
      record(result.data)?.['redirect_url'],
      request.redirectUri,
    );
  }

  const parsed = PlatformAgentAuthorizeCommandSchema.safeParse({
    authorizationId: input.authorizationId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    mode: input.mode,
    maxSecurityLevel: input.maxSecurityLevel,
    expiresInSeconds: input.expiresInSeconds,
  });
  if (!parsed.success) throw new AgentConsentError('invalid-request');
  const choice = parsed.data;
  const project = request.projects.find(
    (candidate) =>
      candidate.tenantId === choice.tenantId &&
      candidate.projectId === choice.projectId,
  );
  if (
    project === undefined ||
    !project.modes.includes(choice.mode) ||
    securityOrder.indexOf(choice.maxSecurityLevel) >
      securityOrder.indexOf(project.maxSecurityLevel)
  ) {
    throw new AgentConsentError('not-allowed');
  }
  try {
    await deps.authorize(token, choice, deps.createIdempotencyKey());
  } catch {
    throw new AgentConsentError('not-allowed');
  }
  let result: OAuthResult;
  try {
    result = await deps.oauth.approveAuthorization(input.authorizationId, {
      skipBrowserRedirect: true,
    });
  } catch {
    throw new AgentConsentError('unavailable');
  }
  if (result.error !== null) throw new AgentConsentError('unavailable');
  return callbackUrl(
    record(result.data)?.['redirect_url'],
    request.redirectUri,
  );
}
