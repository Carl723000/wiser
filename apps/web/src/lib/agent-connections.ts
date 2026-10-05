import {
  PlatformUuidSchema,
  type PlatformAgentConnectionView,
} from '@wiser/platform-contracts';

export type AgentConnectionProjectAccess =
  | {
      readonly state: 'loaded';
      readonly memberStatus: string | null;
      readonly expiresAt: string | null;
      readonly roles: readonly string[];
    }
  | { readonly state: 'not-loaded' | 'not-visible' | 'unavailable' };

export function readAgentConnectionConditions(
  connection: Pick<PlatformAgentConnectionView, 'status' | 'expiresAt'>,
  project: AgentConnectionProjectAccess,
  now: number,
) {
  const connectionStatus =
    connection.status === 'active' &&
    connection.expiresAt !== null &&
    Date.parse(connection.expiresAt) <= now
      ? 'expired'
      : connection.status;
  const memberState =
    project.state !== 'loaded'
      ? 'unknown'
      : project.memberStatus === null
        ? 'none'
        : project.memberStatus === 'revoked' ||
            project.memberStatus === 'suspended' ||
            project.memberStatus === 'expired'
          ? project.memberStatus
          : project.memberStatus !== 'active'
            ? 'unknown'
            : project.expiresAt !== null && Date.parse(project.expiresAt) <= now
              ? 'expired'
              : 'active';
  const currentState =
    connectionStatus === 'revoked'
      ? 'connection-revoked'
      : connectionStatus === 'expired'
        ? 'connection-expired'
        : memberState === 'expired'
          ? 'member-expired'
          : memberState === 'revoked'
            ? 'member-revoked'
            : memberState === 'suspended'
              ? 'member-suspended'
              : memberState === 'none'
                ? 'no-member'
                : memberState === 'unknown'
                  ? 'unknown'
                  : project.state === 'loaded' && project.roles.length === 0
                    ? 'no-role'
                    : 'conditions-met';
  return { connectionStatus, memberState, currentState } as const;
}

export interface AgentConnectionAccountDependencies {
  readonly list: () => Promise<readonly PlatformAgentConnectionView[]>;
  readonly revokeConnection: (connectionId: string) => Promise<void>;
  readonly revokeGrant: (
    clientId: string,
  ) => Promise<{ readonly error: unknown }>;
}

export async function disconnectAgentConnection(
  deps: AgentConnectionAccountDependencies,
  connectionId: string,
): Promise<'disconnected' | 'provider-pending'> {
  if (!PlatformUuidSchema.safeParse(connectionId).success)
    throw new Error('not-allowed');
  const owned = (await deps.list()).find(
    (item) => item.connectionId === connectionId,
  );
  if (!owned) throw new Error('not-allowed');
  try {
    await deps.revokeConnection(owned.connectionId);
  } catch {
    throw new Error('unavailable');
  }
  try {
    const { error } = await deps.revokeGrant(owned.clientId);
    if (
      error === null ||
      (typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        error.status === 404)
    )
      return 'disconnected';
  } catch {
    // Access is already stopped. Retrying must still clear the saved consent.
  }
  return 'provider-pending';
}
