import {
  consumeResourceManagementPermit,
  type ResourceAdministrationOptions,
} from '@wiser/platform-auth';
import {
  PlatformRequestContextSchema,
  ResourcePackageCommandSchema,
  type PlatformRequestContext,
  type ResourceAccessAction,
} from '@wiser/platform-contracts';
import { z } from 'zod';
import type { QueryAdapterPgPool } from './query-adapters.js';
const SourceId = z.string().uuid();

/** A trusted host port. It must resolve a registered source and current provider
 * permission for this project and requested actions; a platform policy alone is
 * never evidence that the provider has granted access. */
export interface ExternalSourcePackageValidatorPort {
  validateExternalSource(input: {
    context: PlatformRequestContext;
    sourceId: string;
    actions: readonly ResourceAccessAction[];
    licenseBasis: string;
    policyWindow?: { readonly startsAt: string; readonly expiresAt: string };
    signal: AbortSignal;
  }): Promise<boolean>;
}
export function createDataResourcePackageValidator(
  pool: QueryAdapterPgPool,
  external?: ExternalSourcePackageValidatorPort,
): ResourceAdministrationOptions['validatePackage'] {
  return async (input) => {
    const context = PlatformRequestContextSchema.safeParse(input.context);
    const command = ResourcePackageCommandSchema.safeParse(input.command);
    if (!context.success || !command.success || input.signal.aborted)
      return false;
    const auth = context.data.authorization;
    if (
      auth.projectId !== command.data.projectId ||
      !auth.scopes.some(
        (scope) =>
          scope === 'platform.membership.manage' ||
          scope === 'platform.access.approve',
      )
    )
      return false;
    const sources = command.data.resources.filter(
      (ref) => ref.kind === 'external-source',
    );
    const versions = command.data.resources.filter(
      (ref) => ref.kind === 'version',
    );
    // Resource packages are homogeneous. A source action cannot be silently
    // applied to a local version, and content/export actions cannot be applied
    // to a provider directory.
    if (sources.length && versions.length) return false;
    if (
      sources.length &&
      (!external ||
        command.data.allowedActions.some(
          (action) =>
            action !== 'source.discover' && action !== 'external.directory',
        ) ||
        sources.some(
          (source) =>
            !SourceId.safeParse(source.sourceId).success ||
            source.sourceId !== source.sourceId.toLowerCase(),
        ))
    )
      return false;
    if (
      versions.length &&
      command.data.allowedActions.includes('external.directory')
    )
      return false;
    const validUntil = consumeResourceManagementPermit(
      input.managementPermit,
      context.data,
      command.data.resources,
      command.data.allowedActions,
    );
    if (!validUntil) return false;
    if (sources.length) {
      try {
        for (const source of sources) {
          if (input.signal.aborted || Date.parse(validUntil) <= Date.now())
            return false;
          const valid = await external!.validateExternalSource({
            context: context.data,
            sourceId: source.sourceId,
            actions: command.data.allowedActions,
            licenseBasis: command.data.licenseBasis,
            ...(input.policyWindow ? { policyWindow: input.policyWindow } : {}),
            signal: input.signal,
          });
          if (!valid) return false;
        }
        return !input.signal.aborted && Date.parse(validUntil) > Date.now();
      } catch {
        return false;
      }
    }
    const client = await pool.connect();
    try {
      await client.query('begin read only');
      await client.query(
        `select set_config('statement_timeout','4000',true),
        set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),
        set_config('wiser.max_security_level',$3,true),set_config('wiser.policy_version',$4,true)`,
        [
          auth.tenantId,
          auth.projectId,
          auth.maxSecurityLevel,
          String(auth.authzVersion),
        ],
      );
      // The transaction is private to this fixed, boolean metadata query. Reuse
      // exact-version RLS transport without changing personal content permissions.
      // Never hand this client/scope to catalog, evidence, asset or export adapters.
      await client.query(
        "/* data.resource.management-metadata-scope */ select set_config('wiser.resource_scope',$1,true),set_config('wiser.resource_action','content.read',true)",
        [
          JSON.stringify({
            mode: 'managed',
            validUntil,
            permissions: { 'content.read': command.data.resources },
          }),
        ],
      );
      if (input.signal.aborted) throw new Error('Cancelled');
      const rows = await client.query(
        `/* data.resource-package.validation */
        select count(*)::int denied from jsonb_array_elements($1::jsonb) ref
        where not exists (
          select 1 from catalog.data_item_version v join catalog.data_item i using(tenant_id,project_id,data_item_id)
          where v.tenant_id=$2 and v.project_id=$3
          and v.data_item_id=(ref->>'dataItemId')::uuid and v.version_id=(ref->>'versionId')::uuid
          and v.committed_at is not null and v.publication_status='PUBLISHED' and i.publication_status='PUBLISHED'
          and v.acceptance_status in ('PASSED','CONDITIONALLY_PASSED') and i.acceptance_status in ('PASSED','CONDITIONALLY_PASSED')
          and length(trim(i.authorization_scope))>0
        )`,
        [JSON.stringify(command.data.resources), auth.tenantId, auth.projectId],
      );
      const valid =
        !input.signal.aborted &&
        Date.parse(validUntil) > Date.now() &&
        rows.rows.length === 1 &&
        rows.rows[0]?.['denied'] === 0;
      await client.query('commit');
      return (
        valid && !input.signal.aborted && Date.parse(validUntil) > Date.now()
      );
    } catch {
      await client.query('rollback').catch(() => undefined);
      return false;
    } finally {
      client.release();
    }
  };
}
