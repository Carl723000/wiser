import { createHash } from 'node:crypto';
import {
  PlatformRequestContextSchema,
  ResourceAccessAuthoritySnapshotSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';
import type { PlatformPrincipalResolverLike } from './platform-credential-principal-resolver.js';
import type { ResolveSupabasePrincipalInput } from './index.js';
import { compileResourceAccessScope } from './resource-access-scope.js';

export class ResourceScopedPrincipalResolver implements PlatformPrincipalResolverLike {
  readonly #base: PlatformPrincipalResolverLike;
  readonly #load: (context: PlatformRequestContext) => Promise<unknown>;
  constructor(options: {
    base: PlatformPrincipalResolverLike;
    load: (context: PlatformRequestContext) => Promise<unknown>;
  }) {
    this.#base = options.base;
    this.#load = options.load;
  }
  async resolve(
    input: ResolveSupabasePrincipalInput,
  ): Promise<PlatformRequestContext | null> {
    try {
      const base = await this.#base.resolve(input);
      const checked = PlatformRequestContextSchema.safeParse(base);
      if (!checked.success) return null;
      const context = checked.data;
      if (
        context.authorization.tenantId !== input.tenantId ||
        context.authorization.projectId !== input.projectId ||
        context.authorization.purpose !== input.purpose
      )
        return null;
      const loaded = ResourceAccessAuthoritySnapshotSchema.safeParse(
        await this.#load(context),
      );
      if (!loaded.success) return null;
      const snapshot = loaded.data;
      if (
        snapshot.tenantId !== context.authorization.tenantId ||
        snapshot.projectId !== context.authorization.projectId ||
        snapshot.actorId !== context.principal.actorId ||
        snapshot.purpose !== context.authorization.purpose
      )
        return null;
      if (snapshot.mode === 'legacy') return context;
      if (context.principal.delegatedBy !== snapshot.delegator?.actorId)
        return null;
      const { revision, ...scopeInput } = snapshot;
      const scope = compileResourceAccessScope(scopeInput);
      if (scope === null || scope.mode !== 'managed') return null;
      // Stable across repeated reads, changes on scope expiry even before the next policy mutation.
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            tenantId: snapshot.tenantId,
            projectId: snapshot.projectId,
            actorId: snapshot.actorId,
            delegatedBy: context.principal.delegatedBy,
            purpose: snapshot.purpose,
            revision,
            scope,
          }),
        )
        .digest('hex');
      return {
        ...context,
        authorization: {
          ...context.authorization,
          resourceAccess: { revision, fingerprint, scope },
        },
      };
    } catch {
      // No fallback to broad roles when the resource authority is unavailable.
      return null;
    }
  }
}
