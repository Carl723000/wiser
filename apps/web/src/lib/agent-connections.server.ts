import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  PlatformAgentConnectionViewSchema,
  type PlatformAgentConnectionView,
  type ProjectAccessProjectView,
} from '@wiser/platform-contracts';
import { agentPlatformRequest } from './agent-consent.server';
import {
  disconnectAgentConnection,
  type AgentConnectionProjectAccess,
} from './agent-connections';
import { createWiserServerSupabaseClient } from './supabase/server';
import { verifiedSessionAccessToken } from './supabase/verified-session';
import { getProjectAccessClient } from './project-access.server';

function projectKey(project: {
  readonly tenantId: string;
  readonly projectId: string;
}) {
  return `${project.tenantId}:${project.projectId}`;
}

// Optional current conditions must never prevent ownership-based disconnection.
async function connectionProjects(
  connections: readonly PlatformAgentConnectionView[],
) {
  const projects = new Map<string, ProjectAccessProjectView>();
  const wanted = new Set(connections.map(projectKey));
  let unresolved: 'not-loaded' | 'not-visible' | 'unavailable' = 'not-loaded';
  if (wanted.size > 0) {
    try {
      const client = getProjectAccessClient();
      for (let page = 0; page < 10; page++) {
        const result = await client.projects({
          offset: page * 50,
          limit: 50,
          search: '',
        });
        for (const project of result.items) {
          const key = projectKey(project);
          if (wanted.has(key)) projects.set(key, project);
        }
        if (projects.size === wanted.size) break;
        if (!result.hasMore) {
          unresolved = 'not-visible';
          break;
        }
        if (result.items.length === 0) break;
      }
    } catch {
      unresolved = 'unavailable';
    }
  }
  return { projects, unresolved };
}

export async function getAgentConnectionAccount() {
  const client = await createWiserServerSupabaseClient();
  if (!client) throw new Error('unavailable');
  const token = await verifiedSessionAccessToken(
    createWiserServerSupabaseClient,
    () => new Date(),
  );
  const list = async () => {
    const result = await agentPlatformRequest(
      '/api/platform/v1/agent-connections',
      token,
      'GET',
    );
    if (
      typeof result !== 'object' ||
      result === null ||
      !('connections' in result)
    )
      throw new Error('unavailable');
    return PlatformAgentConnectionViewSchema.array()
      .max(100)
      .parse(result.connections);
  };
  return {
    async load() {
      const [connections, grants] = await Promise.all([
        list(),
        client.auth.oauth.listGrants(),
      ]);
      if (grants.error || grants.data === null) throw new Error('unavailable');
      const { projects, unresolved } = await connectionProjects(connections);
      return connections.map((item) => {
        const project = projects.get(projectKey(item));
        const projectAccess: AgentConnectionProjectAccess = project
          ? {
              state: 'loaded',
              memberStatus: project.memberStatus,
              expiresAt: project.expiresAt,
              roles: project.roles,
            }
          : { state: unresolved };
        return {
          ...item,
          clientName:
            grants.data.find((grant) => grant.client.id === item.clientId)
              ?.client.name ?? null,
          projectName: project
            ? {
                'zh-CN': project.nameZh,
                en: project.nameEn,
              }
            : null,
          projectAccess,
          providerConsent: grants.data.some(
            (grant) => grant.client.id === item.clientId,
          ),
        };
      });
    },
    disconnect: (connectionId: string) =>
      disconnectAgentConnection(
        {
          list,
          revokeConnection: async (id) => {
            await agentPlatformRequest(
              `/api/platform/v1/agent-connections/${encodeURIComponent(id)}/revoke`,
              token,
              'POST',
              {},
              randomUUID(),
            );
          },
          revokeGrant: (id) => client.auth.oauth.revokeGrant({ clientId: id }),
        },
        connectionId,
      ),
  };
}
