import { isDeepStrictEqual } from 'node:util';
import type { PlatformRequestContext } from '@wiser/platform-contracts';

/** Compare fresh authority, including legacy-to-managed activation, before releasing bytes. */
export function sameDeliveryAuthority(
  before: PlatformRequestContext,
  after: PlatformRequestContext | null,
): boolean {
  if (!after) return false;
  const scope = after.authorization.resourceAccess?.scope;
  if (
    scope &&
    (scope.mode !== 'managed' ||
      (scope.validUntil !== null && Date.parse(scope.validUntil) <= Date.now()))
  )
    return false;
  const snapshot = (context: PlatformRequestContext) => ({
    principal: context.principal,
    authorization: {
      ...context.authorization,
      roles: [...context.authorization.roles].sort(),
      scopes: [...context.authorization.scopes].sort(),
    },
  });
  return isDeepStrictEqual(snapshot(before), snapshot(after));
}
