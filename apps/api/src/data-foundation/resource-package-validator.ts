import {
  consumeResourceManagementPermit,
  type ResourceAdministrationOptions,
} from '@wiser/platform-auth';
import {
  PlatformRequestContextSchema,
  ResourcePackageCommandSchema,
} from '@wiser/platform-contracts';
import type { QueryAdapterPgPool } from './query-adapters.js';
export function createDataResourcePackageValidator(
  pool: QueryAdapterPgPool,
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
    // External sources require their own registered description/permit port.
    // Never infer provider permission from a local Data item or a user-entered URL.
    if (
      command.data.resources.some((ref) => ref.kind !== 'version') ||
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
