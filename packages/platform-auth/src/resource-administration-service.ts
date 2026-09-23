import { ResourcePolicyStore } from './resource-policy-service.js';
import {
  ResourcePolicyProposalSchema,
  ResourcePolicyDecisionSchema,
  ResourcePolicyActionSchema,
  ResourcePolicyRevokeSchema,
  ResourcePolicyRequestsQuerySchema,
  ResourceManagementCatalogQuerySchema,
  ResourceManagementCatalogPageSchema,
  type ResourcePolicyProposal,
  type ResourcePolicyDecision,
  type ResourcePolicyAction,
  type ResourcePolicyRevoke,
  type ResourcePolicyRequestsQuery,
  type ResourcePolicyRequestView,
  type ResourcePolicyRequestsPage,
  type ResourceManagementCatalogQuery,
  type ResourceManagementCatalogPage,
  type ResourcePolicyRevokeReceipt,
} from '@wiser/platform-contracts';
import {
  assertResourceManagementPolicy,
  issueResourceManagementPermit,
  type ResourceManagementPermit,
} from './resource-management-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ResourceGrantsQuerySchema,
  ResourceGrantRevokeCommandSchema,
  ResourceGrantRenewCommandSchema,
  type ResourceGrantsQuery,
  type ResourceGrantsPage,
  type ResourceGrantRevokeCommand,
  type ResourceGrantRevokeReceipt,
  type ResourceGrantRenewCommand,
  type ResourceGrantRenewReceipt,
  ResourceBatchesQuerySchema,
  type ResourceBatchesQuery,
  type ResourceBatchesPage,
  ResourceBatchPreviewCommandSchema,
  ResourceBatchDecisionSchema,
  ResourceBatchActionSchema,
  type ResourceBatchPreviewCommand,
  type ResourceBatchDecision,
  type ResourceBatchAction,
  type ResourceBatchView,
  ResourcePackageCommandSchema,
  ResourcePresetCommandSchema,
  ResourceDefinitionsQuerySchema,
  ResourceDefinitionsPageSchema,
  type PlatformRequestContext,
  type ResourcePackageCommand,
  type ResourcePresetCommand,
  type ResourceDefinitionReceipt,
  type ResourceDefinitionsQuery,
  type ResourceDefinitionsPage,
} from '@wiser/platform-contracts';
import type {
  SupabaseJwtClaimsVerifier,
  VerifiedSupabaseJwtClaims,
} from './index.js';
import type {
  PlatformDelegationTransactionPool,
  PlatformDelegationTransactionClient as Client,
} from './postgres-platform-delegation-service.js';
import {
  createPostgresAuthorizationContextLoader,
  type AuthorizationRow,
} from './postgres-authorization.js';
import { ResourceScopedPrincipalResolver } from './resource-scoped-principal-resolver.js';
import { createPostgresResourceAuthorityLoader } from './postgres-resource-authority.js';

export interface ResourceAdministrationOptions {
  readonly pool: PlatformDelegationTransactionPool;
  readonly verifyHuman: SupabaseJwtClaimsVerifier;
  /** Trusted application port; verifies exact versions, visibility and license constraints.
   * No database join between the control plane and Data authority is permitted. */
  readonly validatePackage: (input: {
    context: PlatformRequestContext;
    command: ResourcePackageCommand;
    signal: AbortSignal;
    managementPermit?: ResourceManagementPermit;
  }) => Promise<boolean>;
  /** Fixed-column Data catalog port for separately appointed source staff. */
  readonly listManagementCatalog?: (input: {
    context: PlatformRequestContext;
    page: ResourceManagementCatalogQuery;
    signal: AbortSignal;
    managementPermit?: ResourceManagementPermit;
  }) => Promise<ResourceManagementCatalogPage>;
}
export { ResourceAdministrationError } from './resource-administration-error.js';
import {
  ResourceAdministrationError,
  resourceAdministrationFailure as fail,
} from './resource-administration-error.js';
import { ResourceBatchStore } from './resource-batch-service.js';
import { ResourceGrantStore } from './resource-grant-service.js';
function uuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    fail('VALIDATION_FAILED');
}
interface Project {
  id: string;
  tenant_id: string;
}
interface Session {
  client: Client;
  human: VerifiedSupabaseJwtClaims;
  project: Project;
  context: PlatformRequestContext;
}
export class PostgresResourceAdministrationService {
  readonly #options: ResourceAdministrationOptions;
  constructor(options: ResourceAdministrationOptions) {
    this.#options = options;
  }
  sourcePolicyRequests(input: {
    token: string;
    projectId: string;
    page: ResourcePolicyRequestsQuery;
  }): Promise<ResourcePolicyRequestsPage> {
    const page = ResourcePolicyRequestsQuerySchema.safeParse(input.page);
    if (!page.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      input.projectId,
      (session) =>
        new ResourcePolicyStore(session, this.#options.validatePackage).list(
          page.data,
        ),
      ['platform.membership.manage', 'platform.access.approve'],
    );
  }
  managementCatalog(input: {
    token: string;
    projectId: string;
    page: ResourceManagementCatalogQuery;
  }): Promise<ResourceManagementCatalogPage> {
    const page = ResourceManagementCatalogQuerySchema.safeParse(input.page);
    if (!page.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      input.projectId,
      async (session) => {
        await new ResourcePolicyStore(
          session,
          this.#options.validatePackage,
        ).requireAuthority('read');
        if (!this.#options.listManagementCatalog)
          fail('RESOURCE_UNAVAILABLE');
        const permit = issueResourceManagementPermit(
          session.context,
          [],
          [],
          new Date(Date.now() + 5000).toISOString(),
          'management-catalog',
        );
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const catalog = await Promise.race([
            this.#options.listManagementCatalog({
              context: session.context,
              page: page.data,
              signal: controller.signal,
              managementPermit: permit,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new ResourceAdministrationError('RESOURCE_UNAVAILABLE'));
              }, 5000);
            }),
          ]);
          const keys = catalog.items.map(
            (item) =>
              `v:${item.dataItemId.toLowerCase()}:${item.versionId.toLowerCase()}`,
          );
          const policyRows = await session.client.query<{
              resource_key: string;
              policy_id: string;
              version: number;
            }>(
              `select distinct on (resource_key) resource_key,policy_id,version
               from platform_private.resource_policy_versions
               where project_id=$1 and resource_key=any($2::text[])
               order by resource_key,version desc`,
              [session.project.id, keys],
            );
          const roleRows = await session.client.query<{ role_key: string }>(
              `select role_key from platform_private.resource_policy_roles
               where project_id=$1 and active and can_propose order by role_key`,
              [session.project.id],
            );
          const latest = new Map(
            policyRows.rows.map((row) => [row.resource_key, row]),
          );
          return ResourceManagementCatalogPageSchema.parse({
            ...catalog,
            items: catalog.items.map((item) => {
              const policy = latest.get(
                `v:${item.dataItemId.toLowerCase()}:${item.versionId.toLowerCase()}`,
              );
              return {
                ...item,
                policyId: policy?.policy_id ?? null,
                expectedPolicyVersion: policy?.version ?? 0,
              };
            }),
            managementRoleOptions: roleRows.rows.map((row) => row.role_key),
          });
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
      },
      ['platform.membership.manage', 'platform.access.approve'],
    );
  }
  proposeSourcePolicy(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePolicyProposal;
  }): Promise<ResourcePolicyRequestView> {
    const command = ResourcePolicyProposalSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      command.data.projectId,
      async (session) => {
        const store = new ResourcePolicyStore(
          session,
          this.#options.validatePackage,
        );
        await store.requireAuthority('propose');
        return this.#write(
          session,
          input.idempotencyKey,
          'source.propose',
          command.data,
          () => store.propose(command.data),
        );
      },
      'platform.membership.manage',
    );
  }
  decideSourcePolicy(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePolicyDecision;
  }): Promise<ResourcePolicyRequestView> {
    const command = ResourcePolicyDecisionSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      command.data.projectId,
      async (session) => {
        const store = new ResourcePolicyStore(
          session,
          this.#options.validatePackage,
        );
        await store.requireAuthority('approve');
        return this.#write(
          session,
          input.idempotencyKey,
          'source.decide',
          command.data,
          () => store.decide(command.data),
        );
      },
      'platform.access.approve',
    );
  }
  withdrawSourcePolicy(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePolicyAction;
  }): Promise<ResourcePolicyRequestView> {
    const command = ResourcePolicyActionSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      command.data.projectId,
      async (session) => {
        const store = new ResourcePolicyStore(
          session,
          this.#options.validatePackage,
        );
        await store.requireAuthority('propose');
        return this.#write(
          session,
          input.idempotencyKey,
          'source.withdraw',
          command.data,
          () => store.withdraw(command.data),
        );
      },
      'platform.membership.manage',
    );
  }
  revokeSourcePolicy(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePolicyRevoke;
  }): Promise<ResourcePolicyRevokeReceipt> {
    const command = ResourcePolicyRevokeSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      command.data.projectId,
      async (session) => {
        const store = new ResourcePolicyStore(
          session,
          this.#options.validatePackage,
        );
        await store.requireAuthority('propose');
        return this.#write(
          session,
          input.idempotencyKey,
          'source.revoke',
          command.data,
          () => store.revoke(command.data),
        );
      },
      'platform.membership.manage',
    );
  }
  grants(input: {
    token: string;
    projectId: string;
    page: ResourceGrantsQuery;
  }): Promise<ResourceGrantsPage> {
    const page = ResourceGrantsQuerySchema.safeParse(input.page);
    if (!page.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      input.projectId,
      (session) =>
        new ResourceGrantStore(session, this.#options.validatePackage).list(
          page.data,
        ),
      'self',
    );
  }
  revokeGrant(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceGrantRevokeCommand;
  }): Promise<ResourceGrantRevokeReceipt> {
    const command = ResourceGrantRevokeCommandSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(input.token, command.data.projectId, (session) =>
      this.#write(
        session,
        input.idempotencyKey,
        'grant.revoke',
        command.data,
        () =>
          new ResourceGrantStore(session, this.#options.validatePackage).revoke(
            command.data,
          ),
      ),
    );
  }
  renewGrant(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceGrantRenewCommand;
  }): Promise<ResourceGrantRenewReceipt> {
    const command = ResourceGrantRenewCommandSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(input.token, command.data.projectId, (session) =>
      this.#write(
        session,
        input.idempotencyKey,
        'grant.renew',
        command.data,
        () =>
          new ResourceGrantStore(session, this.#options.validatePackage).renew(
            command.data,
          ),
      ),
    );
  }
  batches(input: {
    token: string;
    projectId: string;
    page: ResourceBatchesQuery;
  }): Promise<ResourceBatchesPage> {
    const page = ResourceBatchesQuerySchema.safeParse(input.page);
    if (!page.success) fail('VALIDATION_FAILED');
    return this.#transaction(
      input.token,
      input.projectId,
      (session) =>
        new ResourceBatchStore(session, this.#options.validatePackage).list(
          page.data,
        ),
      ['platform.membership.manage', 'platform.access.approve'],
    );
  }
  withdrawBatch(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceBatchAction;
  }): Promise<ResourceBatchView> {
    const command = ResourceBatchActionSchema.safeParse(input.command);
    if (!command.success) fail('VALIDATION_FAILED');
    return this.#transaction(input.token, command.data.projectId, (session) =>
      this.#write(
        session,
        input.idempotencyKey,
        'batch.withdraw',
        command.data,
        () =>
          new ResourceBatchStore(
            session,
            this.#options.validatePackage,
          ).withdraw(command.data),
      ),
    );
  }
  previewBatch(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceBatchPreviewCommand;
  }): Promise<ResourceBatchView> {
    const parsed = ResourceBatchPreviewCommandSchema.safeParse(input.command);
    if (!parsed.success) fail('VALIDATION_FAILED');
    const command = parsed.data;
    return this.#transaction(
      input.token,
      command.projectId,
      (session) =>
        this.#write(
          session,
          input.idempotencyKey,
          'batch.preview',
          command,
          () =>
            new ResourceBatchStore(
              session,
              this.#options.validatePackage,
            ).preview(command),
        ),
      'platform.membership.manage',
    );
  }
  decideBatch(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceBatchDecision;
  }): Promise<ResourceBatchView> {
    const parsed = ResourceBatchDecisionSchema.safeParse(input.command);
    if (!parsed.success) fail('VALIDATION_FAILED');
    const command = parsed.data;
    return this.#transaction(
      input.token,
      command.projectId,
      (session) =>
        this.#write(
          session,
          input.idempotencyKey,
          'batch.decide',
          command,
          () =>
            new ResourceBatchStore(
              session,
              this.#options.validatePackage,
            ).decide(command),
        ),
      'platform.access.approve',
    );
  }
  executeBatch(input: {
    token: string;
    idempotencyKey: string;
    command: ResourceBatchAction;
  }): Promise<ResourceBatchView> {
    const parsed = ResourceBatchActionSchema.safeParse(input.command);
    if (!parsed.success) fail('VALIDATION_FAILED');
    const command = parsed.data;
    return this.#transaction(
      input.token,
      command.projectId,
      (session) =>
        this.#write(
          session,
          input.idempotencyKey,
          'batch.execute',
          command,
          () =>
            new ResourceBatchStore(
              session,
              this.#options.validatePackage,
            ).execute(command),
        ),
      'platform.membership.manage',
    );
  }
  definitions(input: {
    token: string;
    projectId: string;
    page: ResourceDefinitionsQuery;
  }): Promise<ResourceDefinitionsPage> {
    const parsed = ResourceDefinitionsQuerySchema.safeParse(input.page);
    if (!parsed.success)
      return Promise.reject(
        new ResourceAdministrationError('VALIDATION_FAILED'),
      );
    const page = parsed.data;
    return this.#transaction(
      input.token,
      input.projectId,
      async ({ client, project }) => {
        const packageList = page.kind === 'package';
        const table = packageList
          ? 'resource_package_versions'
          : 'resource_preset_versions';
        const id = packageList ? 'package_id' : 'preset_id';
        const fields = packageList
          ? 'jsonb_array_length(resources)::int "resourceCount",allowed_actions "allowedActions",license_basis "licenseBasis"'
          : 'actions,max_days "maxDays",approval_level "approvalLevel"';
        const result = await client.query<Record<string, unknown>>(
          `select ${id} id,version,name,created_at "createdAt",${fields}
         from (select distinct on (${id}) * from platform_private.${table}
          where project_id=$1 order by ${id},version desc) latest
         where position(lower($2) in lower(name))>0
         order by name,${id} offset $3 limit $4`,
          [project.id, page.search, page.offset, page.limit + 1],
        );
        const revision = await client.query<{ revision: string }>(
          'select revision from platform_private.resource_access_settings where project_id=$1',
          [project.id],
        );
        return ResourceDefinitionsPageSchema.parse({
          items: result.rows.slice(0, page.limit).map((row) => ({
            ...row,
            kind: page.kind,
            createdAt:
              row['createdAt'] instanceof Date
                ? row['createdAt'].toISOString()
                : row['createdAt'],
          })),
          hasMore: result.rows.length > page.limit,
          authorityRevision: Number(revision.rows[0]?.revision),
        });
      },
    );
  }
  async #transaction<T>(
    token: string,
    projectId: string,
    work: (session: Session) => Promise<T>,
    requiredScope:
      | 'self'
      | 'platform.membership.manage'
      | 'platform.access.approve'
      | readonly (
          'platform.membership.manage' | 'platform.access.approve'
        )[] = 'platform.membership.manage',
  ): Promise<T> {
    uuid(projectId);
    const human = await this.#options.verifyHuman(token);
    if (!human) fail('NOT_AUTHENTICATED');
    const client = await this.#options.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        "select set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)",
      );
      const live = await client.query(
        `select a.id from platform.actors a join auth.sessions s on s.user_id=a.auth_user_id and s.id=$2
        where a.id=$1 and a.actor_type='human' and a.status='active' and s.oauth_client_id is null
        and (s.not_after is null or s.not_after>statement_timestamp()) for share of a,s`,
        [human.userId, human.sessionId],
      );
      if (live.rows.length !== 1) fail('NOT_AUTHENTICATED');
      const rows = await client.query<Project>(
        `select p.id,p.tenant_id from platform.projects p join platform.tenants t on t.id=p.tenant_id
        where p.id=$1 and p.status='active' and t.status='active' for update of p`,
        [projectId],
      );
      const project = rows.rows[0];
      if (!project) fail('NOT_AUTHORIZED');
      const authorization = await createPostgresAuthorizationContextLoader(
        (sql, values) => client.query<AuthorizationRow>(sql, values),
      )({
        actorId: human.userId,
        sessionId: human.sessionId,
        tenantId: project.tenant_id,
        projectId,
        purpose: 'web-console',
      });
      if (
        !authorization ||
        (requiredScope !== 'self' &&
          !(
            typeof requiredScope === 'string' ? [requiredScope] : requiredScope
          ).some((scope) => authorization.scopes.includes(scope)))
      )
        fail('NOT_AUTHORIZED');
      const settings = await client.query(
        'select revision from platform_private.resource_access_settings where project_id=$1 for update',
        [projectId],
      );
      if (settings.rows.length !== 1) fail('RESOURCE_POLICY_NOT_ENABLED');
      const base: PlatformRequestContext = {
        principal: {
          actorType: 'human',
          actorId: human.userId,
          authUserId: human.userId,
          sessionId: human.sessionId,
          authenticationMethod: 'supabase_jwt',
        },
        authorization,
        traceId: randomUUID().replaceAll('-', ''),
      };
      const scoped = new ResourceScopedPrincipalResolver({
        base: { resolve: () => Promise.resolve(base) },
        load: createPostgresResourceAuthorityLoader((sql, values) =>
          client.query<{ snapshot: unknown }>(sql, values),
        ),
      });
      const context = await scoped.resolve({
        token,
        tenantId: project.tenant_id,
        projectId,
        purpose: 'web-console',
        traceId: base.traceId,
      });
      if (!context) fail('NOT_AUTHORIZED');
      const result = await work({ client, human, project, context });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async #write<T>(
    session: Session,
    key: string,
    kind: string,
    command: unknown,
    work: () => Promise<T>,
  ) {
    uuid(key);
    const { client, human, project } = session;
    const hash = createHash('sha256')
      .update(JSON.stringify({ action: 'resource.' + kind + '.save', command }))
      .digest('hex');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      human.userId + ':' + key,
    ]);
    const prior = await client.query<{
      request_hash: string;
      result: T;
    }>(
      'select request_hash,result from platform_private.project_access_mutations where actor_id=$1 and idempotency_key=$2',
      [human.userId, key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) fail('IDEMPOTENCY_CONFLICT');
      return prior.rows[0].result;
    }
    const result = await work();
    await client.query(
      'insert into platform_private.project_access_mutations(actor_id,idempotency_key,project_id,request_hash,result) values($1,$2,$3,$4,$5::jsonb)',
      [human.userId, key, project.id, hash, JSON.stringify(result)],
    );
    return result;
  }
  async #version(
    client: Client,
    projectId: string,
    kind: 'package' | 'preset',
    id: string,
    expected: number,
  ) {
    // Both identifiers come from this internal enum, never request text.
    const table =
      kind === 'package'
        ? 'resource_package_versions'
        : 'resource_preset_versions';
    const column = kind === 'package' ? 'package_id' : 'preset_id';
    const prior = await client.query<{ version: number }>(
      `select coalesce(max(version),0)::int version from platform_private.${table} where project_id=$1 and ${column}=$2`,
      [projectId, id],
    );
    if (prior.rows[0]?.version !== expected) fail('VERSION_CONFLICT');
    return expected + 1;
  }
  async #receipt(
    session: Session,
    kind: 'package' | 'preset',
    id: string,
    version: number,
    reason: string,
  ): Promise<ResourceDefinitionReceipt> {
    const { client, human, project } = session;
    const row = await client.query<{ revision: string }>(
      'select revision from platform_private.resource_access_settings where project_id=$1',
      [project.id],
    );
    const authorityRevision = Number(row.rows[0]?.revision);
    if (!Number.isSafeInteger(authorityRevision) || authorityRevision < 1)
      fail('AUTHORITY_UNAVAILABLE');
    const receipt = { kind, id, version, authorityRevision };
    await client.query(
      `insert into platform_private.resource_access_events(project_id,actor_id,action,subject_id,reason,before_state,after_state) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [
        project.id,
        human.userId,
        kind + '.create',
        id,
        reason,
        JSON.stringify({ version: version - 1 }),
        JSON.stringify(receipt),
      ],
    );
    return receipt;
  }
  async savePackage(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePackageCommand;
  }): Promise<ResourceDefinitionReceipt> {
    const parsed = ResourcePackageCommandSchema.safeParse(input.command);
    if (!parsed.success) fail('VALIDATION_FAILED');
    const command = parsed.data;
    return this.#transaction(input.token, command.projectId, (session) =>
      this.#write(
        session,
        input.idempotencyKey,
        'package',
        command,
        async () => {
          const version = await this.#version(
            session.client,
            command.projectId,
            'package',
            command.packageId,
            command.expectedVersion,
          );
          const managementPermit = await assertResourceManagementPolicy(
            session,
            command.resources,
            command.allowedActions,
          );
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const valid = await Promise.race([
              this.#options.validatePackage({
                context: session.context,
                managementPermit,
                command,
                signal: controller.signal,
              }),
              new Promise<boolean>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(
                    new ResourceAdministrationError('RESOURCE_UNAVAILABLE'),
                  );
                }, 5000);
              }),
            ]);
            if (!valid) fail('RESOURCE_UNAVAILABLE');
          } catch {
            fail('RESOURCE_UNAVAILABLE');
          } finally {
            if (timer) clearTimeout(timer);
            controller.abort();
          }
          await session.client.query(
            `insert into platform_private.resource_package_versions(project_id,package_id,version,name,resources,allowed_actions,license_basis,created_by) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
            [
              command.projectId,
              command.packageId,
              version,
              command.name,
              JSON.stringify(command.resources),
              command.allowedActions,
              command.licenseBasis,
              session.human.userId,
            ],
          );
          return this.#receipt(
            session,
            'package',
            command.packageId,
            version,
            command.reason,
          );
        },
      ),
    );
  }
  async savePreset(input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePresetCommand;
  }): Promise<ResourceDefinitionReceipt> {
    const parsed = ResourcePresetCommandSchema.safeParse(input.command);
    if (!parsed.success) fail('VALIDATION_FAILED');
    const command = parsed.data;
    return this.#transaction(input.token, command.projectId, (session) =>
      this.#write(
        session,
        input.idempotencyKey,
        'preset',
        command,
        async () => {
          const version = await this.#version(
            session.client,
            command.projectId,
            'preset',
            command.presetId,
            command.expectedVersion,
          );
          await session.client.query(
            `insert into platform_private.resource_preset_versions(project_id,preset_id,version,name,actions,max_days,approval_level,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              command.projectId,
              command.presetId,
              version,
              command.name,
              command.actions,
              command.maxDays,
              command.approvalLevel,
              session.human.userId,
            ],
          );
          return this.#receipt(
            session,
            'preset',
            command.presetId,
            version,
            command.reason,
          );
        },
      ),
    );
  }
}
