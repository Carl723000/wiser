import { randomUUID } from 'node:crypto';
import type { ResourceAdministrationOptions } from '@wiser/platform-auth';
import { assertResourceManagementPolicy } from '@wiser/platform-auth';
type Input = Parameters<ResourceAdministrationOptions['validatePackage']>[0];
/** Synthetic trusted control snapshot; never used by runtime composition. */
export async function authorizeManagementMetadata(
  input: Input,
): Promise<Input> {
  const context = structuredClone(input.context),
    a = context.authorization;
  a.scopes = ['platform.membership.manage'];
  a.roles = ['source-steward'];
  const now = Date.now();
  const managementPermit = await assertResourceManagementPolicy(
    {
      context,
      client: {
        release() {},
        query: <Row>() =>
          Promise.resolve({
            rows: [
              {
                snapshot: {
                  mode: 'managed',
                  tenantId: a.tenantId,
                  projectId: a.projectId,
                  actorId: context.principal.actorId,
                  purpose: a.purpose,
                  now: new Date(now).toISOString(),
                  revision: 1,
                  grants: [],
                  limits: input.command.resources.map((resource) => ({
                    id: randomUUID(),
                    version: 1,
                    tenantId: a.tenantId,
                    projectId: a.projectId,
                    resource,
                    allowedActions: input.command.allowedActions,
                    managementRoles: ['source-steward'],
                    licenseBasis: 'Synthetic independent permit',
                    status: 'active',
                    startsAt: new Date(now - 3600000).toISOString(),
                    expiresAt: new Date(now + 3600000).toISOString(),
                    maxGrantDays: 1,
                  })),
                },
              },
            ] as Row[],
            rowCount: 1,
          }),
      },
    },
    input.command.resources,
    input.command.allowedActions,
  );
  return { ...input, context, managementPermit };
}
