import { createHash, randomUUID } from 'node:crypto';
import {
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
  }) => Promise<boolean>;
}
export class ResourceAdministrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResourceAdministrationError';
  }
}
function fail(code: string): never {
  throw new ResourceAdministrationError(code);
}
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
      if (!authorization?.scopes.includes('platform.membership.manage'))
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
  async #write(
    session: Session,
    key: string,
    kind: 'package' | 'preset',
    command: ResourcePackageCommand | ResourcePresetCommand,
    work: () => Promise<ResourceDefinitionReceipt>,
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
      result: ResourceDefinitionReceipt;
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
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const valid = await Promise.race([
              this.#options.validatePackage({
                context: session.context,
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
