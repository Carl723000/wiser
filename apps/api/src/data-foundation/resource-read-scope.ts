import {
  ResourceAccessContextSchema,
  type AuthorizedContext,
} from '@wiser/platform-contracts';
import { DataCapabilityHandlerError } from './capability-handler.js';
export interface ResourceScopeClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}
/** Call after BEGIN and before any resource read; the pool must never retain a session setting. */
export async function applyResourceReadScope(
  client: ResourceScopeClient,
  authorization: Pick<AuthorizedContext, 'resourceAccess'>,
  action: 'content.read' | 'original.read' | 'result.export' = 'content.read',
): Promise<void> {
  if (authorization.resourceAccess === undefined) return;
  const parsed = ResourceAccessContextSchema.safeParse(
    authorization.resourceAccess,
  );
  if (!parsed.success || parsed.data.scope.mode !== 'managed')
    throw new DataCapabilityHandlerError('FORBIDDEN');
  const scope = parsed.data.scope;
  if (scope.validUntil !== null && Date.parse(scope.validUntil) <= Date.now())
    throw new DataCapabilityHandlerError('FORBIDDEN');
  await client.query(
    "/* data.resource.read-scope */ select set_config('wiser.resource_scope',$1,true),set_config('wiser.resource_action',$2,true)",
    [JSON.stringify(scope), action],
  );
}
