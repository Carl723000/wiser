import type { PlatformRequestContext } from '@wiser/platform-contracts';
export type ResourceAuthorityQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: readonly { snapshot: unknown }[] }>;
export function createPostgresResourceAuthorityLoader(
  _query: ResourceAuthorityQuery,
) {
  return async (_context: PlatformRequestContext): Promise<unknown> => null;
}
