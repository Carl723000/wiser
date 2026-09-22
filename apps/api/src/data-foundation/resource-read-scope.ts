import type { AuthorizedContext } from '@wiser/platform-contracts';
export interface ResourceScopeClient {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}
export async function applyResourceReadScope(
  _client: ResourceScopeClient,
  _authorization: Pick<AuthorizedContext, 'resourceAccess'>,
  _action: 'content.read' | 'original.read' | 'result.export' = 'content.read',
): Promise<void> {}
