import type { PlatformRequestContext } from '@wiser/platform-contracts';
import type { PlatformPrincipalResolverLike } from './platform-credential-principal-resolver.js';
import type { ResolveSupabasePrincipalInput } from './index.js';
export class ResourceScopedPrincipalResolver {
  constructor(_options: {
    base: PlatformPrincipalResolverLike;
    load: (context: PlatformRequestContext) => Promise<unknown>;
  }) {}
  async resolve(
    _input: ResolveSupabasePrincipalInput,
  ): Promise<PlatformRequestContext | null> {
    return null;
  }
}
