import {
  PlatformRequestContextSchema,
  ResourceManagementCatalogPageSchema,
  ResourceManagementCatalogQuerySchema,
  type ResourceManagementCatalogPage,
} from '@wiser/platform-contracts';
import {
  consumeResourceManagementPermit,
  type ResourceAdministrationOptions,
} from '@wiser/platform-auth';
import type { QueryAdapterPgPool } from './query-adapters.js';

interface CatalogRow {
  data_item_id: string;
  version_id: string;
  name: string;
  source_organization: string;
  version_number: string | number;
  security_level: string;
  processing_stage: string;
  publication_status: string;
  acceptance_status: string;
}

/** Trusted, fixed-column Data port. The control service issues a one-use permit
 * only after checking a live source-steward/reviewer appointment. */
export function createDataManagementCatalogReader(
  pool: QueryAdapterPgPool,
): NonNullable<ResourceAdministrationOptions['listManagementCatalog']> {
  return async (input): Promise<ResourceManagementCatalogPage> => {
    const context = PlatformRequestContextSchema.safeParse(input.context),
      page = ResourceManagementCatalogQuerySchema.safeParse(input.page);
    if (!context.success || !page.success || input.signal.aborted)
      throw Error('Management catalog unavailable');
    const auth = context.data.authorization;
    const validUntil = consumeResourceManagementPermit(
      input.managementPermit,
      context.data,
      [],
      [],
    );
    if (
      !validUntil ||
      !auth.scopes.some(
        (scope) =>
          scope === 'platform.membership.manage' ||
          scope === 'platform.access.approve',
      )
    )
      throw Error('Management catalog unavailable');
    const client = await pool.connect();
    try {
      await client.query('begin read only');
      // SET LOCAL ROLE drops the API's broad inherited table grants. This role
      // has SELECT only on the listed catalog columns and still obeys Data RLS.
      await client.query('set local role wiser_data_metadata');
      await client.query(
        `select set_config('statement_timeout','4000',true),
          set_config('wiser.tenant_id',$1,true),
          set_config('wiser.project_id',$2,true),
          set_config('wiser.max_security_level',$3,true),
          set_config('wiser.policy_version',$4,true),
          set_config('wiser.resource_scope','',true),
          set_config('wiser.resource_action','',true)`,
        [
          auth.tenantId,
          auth.projectId,
          auth.maxSecurityLevel,
          String(auth.authzVersion),
        ],
      );
      if (input.signal.aborted) throw Error('Management catalog cancelled');
      const result = await client.query(
        `/* data.management-catalog.list */
        select i.data_item_id,v.version_id,i.name,i.source_organization,
          v.version_number,v.security_level,v.processing_stage,
          v.publication_status,v.acceptance_status
        from catalog.data_item i join catalog.data_item_version v
          using(tenant_id,project_id,data_item_id)
        where i.tenant_id=$1 and i.project_id=$2
          and i.publication_status='PUBLISHED'
          and i.acceptance_status in ('PASSED','CONDITIONALLY_PASSED')
          and v.publication_status='PUBLISHED'
          and v.acceptance_status in ('PASSED','CONDITIONALLY_PASSED')
          and v.committed_at is not null
          and length(trim(i.authorization_scope))>0
          and ($3='' or position(lower($3) in lower(i.name))>0
            or position(lower($3) in lower(i.source_organization))>0)
        order by i.name,i.data_item_id,v.version_number desc,v.version_id
        offset $4 limit $5`,
        [
          auth.tenantId,
          auth.projectId,
          page.data.search,
          page.data.offset,
          page.data.limit + 1,
        ],
      );
      const rows = result.rows as unknown as readonly CatalogRow[];
      const value = ResourceManagementCatalogPageSchema.parse({
        items: rows.slice(0, page.data.limit).map((row) => ({
          dataItemId: row.data_item_id,
          versionId: row.version_id,
          name: row.name,
          sourceOrganization: row.source_organization,
          versionNumber: Number(row.version_number),
          securityLevel: row.security_level,
          processingStage: row.processing_stage,
          publicationStatus: row.publication_status,
          acceptanceStatus: row.acceptance_status,
        })),
        hasMore: rows.length > page.data.limit,
        checkedAt: new Date().toISOString(),
      });
      if (input.signal.aborted || Date.parse(validUntil) <= Date.now())
        throw Error('Management catalog expired');
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
