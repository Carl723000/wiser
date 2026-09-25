import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformAgentAuthorizationView } from '@wiser/platform-contracts';

import {
  decideAgentConsent,
  loadAgentConsent,
  type AgentConsentDependencies,
} from './agent-consent';

const authorizationId = 'request_123';
const clientId = randomUUID();
const tenantId = randomUUID();
const projectId = randomUUID();
const otherProjectId = randomUUID();
const redirectUri = 'http://127.0.0.1:17777/callback';
const resource = 'https://mcp.wiser.thuenv.tiangong.world:7100/mcp';

function fixture(): AgentConsentDependencies {
  const view: PlatformAgentAuthorizationView = {
    authorizationId,
    clientId,
    clientName: 'Research client',
    redirectUri,
    resource,
    projects: [
      {
        tenantId,
        projectId,
        tenantName: { 'zh-CN': '研究组', en: 'Research group' },
        projectName: { 'zh-CN': '河流项目', en: 'River project' },
        modes: ['query'],
        maxSecurityLevel: 'L1_INTERNAL',
      },
    ],
  };
  return {
    oauth: {
      getAuthorizationDetails: vi.fn().mockResolvedValue({
        data: {
          authorization_id: authorizationId,
          client: { id: clientId, name: 'Research client' },
          redirect_uri: redirectUri,
          scope: 'openid profile',
        },
        error: null,
      }),
      approveAuthorization: vi.fn().mockResolvedValue({
        data: {
          redirect_url: `${redirectUri}?code=authorization-code&state=state`,
        },
        error: null,
      }),
      denyAuthorization: vi.fn().mockResolvedValue({
        data: {
          redirect_url: `${redirectUri}?error=access_denied&state=state`,
        },
        error: null,
      }),
    },
    inspect: vi.fn().mockResolvedValue(view),
    authorize: vi.fn().mockResolvedValue({ connectionId: randomUUID() }),
    createIdempotencyKey: () => randomUUID(),
  };
}

describe('WISER MCP browser consent', () => {
  it('binds the OAuth request to the user, then shows only eligible projects', async () => {
    const deps = fixture();
    const request = await loadAgentConsent(
      deps,
      'direct-user-token',
      authorizationId,
    );
    expect(deps.oauth.getAuthorizationDetails).toHaveBeenCalledWith(
      authorizationId,
    );
    expect(deps.inspect).toHaveBeenCalledWith(
      'direct-user-token',
      authorizationId,
    );
    expect(request).toMatchObject({
      kind: 'request',
      clientName: 'Research client',
      scopes: ['openid', 'profile'],
      projects: [{ projectId, modes: ['query'] }],
    });
  });

  it('creates the bounded project grant before OAuth approval, then redirects to the registered callback', async () => {
    const deps = fixture();
    const order: string[] = [];
    vi.mocked(deps.authorize).mockImplementation((_token, command) => {
      order.push('project-grant');
      expect(command).toMatchObject({
        authorizationId,
        tenantId,
        projectId,
        mode: 'query',
        expiresInSeconds: 900,
      });
      return Promise.resolve({ connectionId: randomUUID() });
    });
    vi.mocked(deps.oauth.approveAuthorization).mockImplementation(() => {
      order.push('oauth-approval');
      return Promise.resolve({
        data: { redirect_url: `${redirectUri}?code=code` },
        error: null,
      });
    });
    const redirect = await decideAgentConsent(deps, 'direct-user-token', {
      authorizationId,
      decision: 'approve',
      tenantId,
      projectId,
      mode: 'query',
      maxSecurityLevel: 'L1_INTERNAL',
      expiresInSeconds: 900,
    });
    expect(order).toEqual(['project-grant', 'oauth-approval']);
    expect(redirect).toBe(`${redirectUri}?code=code`);
    expect(deps.oauth.approveAuthorization).toHaveBeenCalledWith(
      authorizationId,
      {
        skipBrowserRedirect: true,
      },
    );
  });

  it('rejects another project and a write mode before creating a grant or issuing a code', async () => {
    const deps = fixture();
    for (const choice of [
      { projectId: otherProjectId, mode: 'query' as const },
      { projectId, mode: 'ingest' as const },
    ]) {
      await expect(
        decideAgentConsent(deps, 'direct-user-token', {
          authorizationId,
          decision: 'approve',
          tenantId,
          maxSecurityLevel: 'L1_INTERNAL',
          expiresInSeconds: 900,
          ...choice,
        }),
      ).rejects.toMatchObject({ reason: 'not-allowed' });
    }
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  it('sends refusal to OAuth without creating any project grant', async () => {
    const deps = fixture();
    const redirect = await decideAgentConsent(deps, 'direct-user-token', {
      authorizationId,
      decision: 'deny',
    });
    expect(redirect).toContain('error=access_denied');
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.oauth.denyAuthorization).toHaveBeenCalledWith(authorizationId, {
      skipBrowserRedirect: true,
    });
  });

  it('fails closed when the OAuth client or callback disagrees with the WISER authorization', async () => {
    const deps = fixture();
    vi.mocked(deps.inspect).mockResolvedValue({
      ...(await deps.inspect('direct-user-token', authorizationId)),
      clientId: randomUUID(),
    });
    await expect(
      loadAgentConsent(deps, 'direct-user-token', authorizationId),
    ).rejects.toMatchObject({ reason: 'mismatch' });
    expect(deps.authorize).not.toHaveBeenCalled();
  });
});
