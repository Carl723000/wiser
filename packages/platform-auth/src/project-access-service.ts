import { createHash, randomUUID } from 'node:crypto';
import {
  ProjectAccessGrantSchema,
  ProjectAccessPageSchema,
  ProjectAccessRevokeSchema,
  type ProjectAccessGrant,
  type ProjectAccessPage,
  type ProjectAccessRevoke,
  type ProjectAccessMemberView,
  type ProjectAccessProjectView,
} from '@wiser/platform-contracts';
import type { AuthorizedContext } from '@wiser/platform-contracts';
import type {
  SupabaseJwtClaimsVerifier,
  VerifiedSupabaseJwtClaims,
} from './index.js';
import {
  createPostgresAuthorizationContextLoader,
  type AuthorizationRow,
} from './postgres-authorization.js';
import type {
  PlatformDelegationTransactionClient as Client,
  PlatformDelegationTransactionPool,
} from './postgres-platform-delegation-service.js';
import {
  checkProjectGrant,
  checkProjectRemoval,
  type ProjectAccessPolicyError,
} from './project-access-policy.js';

export type ProjectAccessErrorCode =
  | ProjectAccessPolicyError
  | 'NOT_AUTHENTICATED'
  | 'VALIDATION_FAILED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MEMBER_UNAVAILABLE';
export class ProjectAccessError extends Error {
  constructor(readonly code: ProjectAccessErrorCode) {
    super(code);
    this.name = 'ProjectAccessError';
  }
}
export interface ProjectAccessServiceOptions {
  readonly pool: PlatformDelegationTransactionPool;
  readonly verifyHuman: SupabaseJwtClaimsVerifier;
}
interface SessionInput {
  readonly token: string;
}
interface WriteInput<T> extends SessionInput {
  readonly idempotencyKey: string;
  readonly command: T;
}
interface ProjectRow {
  id: string;
  tenant_id: string;
  name_zh_cn: string;
  name_en: string;
  requests_enabled: boolean;
  now: Date;
}
interface MemberRow {
  actor_id: string;
  display_name: string;
  email: string;
  status: string;
  membership_version: number;
  expires_at: Date | null;
  protected: boolean;
  roles: { roleKey: string; expiresAt: string | null }[];
}
const MEMBER_SELECT = `select m.actor_id,coalesce(u.display_name,'') display_name,a.email,
 case when m.status='active' and m.expires_at<=statement_timestamp() then 'expired' else m.status end status,
 m.membership_version,m.expires_at,
 exists(select 1 from platform.role_bindings b join platform.roles r on r.id=b.role_id
 join platform.role_scopes s on s.role_id=r.id where b.actor_id=m.actor_id and b.tenant_id=m.tenant_id
 and (b.project_id is null or b.project_id=m.project_id) and b.status='active' and r.status='active'
 and b.effective_at<=statement_timestamp() and (b.expires_at is null or b.expires_at>statement_timestamp())
 and s.scope like 'platform.%') protected,
 coalesce((select jsonb_agg(jsonb_build_object('roleKey',r.role_key,'expiresAt',b.expires_at) order by r.role_key)
 from platform.role_bindings b join platform.roles r on r.id=b.role_id
 where b.actor_id=m.actor_id and b.tenant_id=m.tenant_id and (b.project_id is null or b.project_id=m.project_id)
 and b.status='active' and r.status='active' and b.effective_at<=statement_timestamp()
 and (b.expires_at is null or b.expires_at>statement_timestamp())),'[]'::jsonb) roles
 from platform.project_memberships m join auth.users a on a.id=m.actor_id
 left join platform.user_profiles u on u.actor_id=m.actor_id`;
function memberView(row: MemberRow): ProjectAccessMemberView {
  return {
    actorId: row.actor_id,
    displayName: row.display_name,
    email: row.email,
    status: row.status,
    version: Number(row.membership_version),
    expiresAt: row.expires_at?.toISOString() ?? null,
    protected: row.protected,
    roles: row.roles,
  };
}
function uuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ProjectAccessError('VALIDATION_FAILED');
}

export class PostgresProjectAccessService {
  readonly #options: ProjectAccessServiceOptions;
  constructor(options: ProjectAccessServiceOptions) {
    this.#options = options;
  }
  async #advanceAuthorization(
    client: Client,
    project: ProjectRow,
    actorId: string,
  ) {
    // The existing resolver uses the greatest control-plane version. Advancing only
    // the actor counter could leave that effective version unchanged.
    await client.query(
      `update platform.actors a set authz_version=greatest(a.authz_version,
       (select version from platform.projects where id=$2),
       (select version from platform.tenants where id=$3),
       (select membership_version from platform.project_memberships where project_id=$2 and actor_id=$1),
       (select membership_version from platform.tenant_memberships where tenant_id=$3 and actor_id=$1))+1,
       updated_at=statement_timestamp() where a.id=$1`,
      [actorId, project.id, project.tenant_id],
    );
  }
  async #transaction<T>(
    token: string,
    work: (client: Client, human: VerifiedSupabaseJwtClaims) => Promise<T>,
  ): Promise<T> {
    const human = await this.#options.verifyHuman(token);
    if (human === null) throw new ProjectAccessError('NOT_AUTHENTICATED');
    const client = await this.#options.pool.connect();
    try {
      await client.query('begin');
      const live = await client.query(
        `select a.id from platform.actors a join auth.sessions s on s.user_id=a.auth_user_id and s.id=$2
    where a.id=$1 and a.actor_type='human' and a.status='active' and s.oauth_client_id is null
    and (s.not_after is null or s.not_after>statement_timestamp()) for share of a,s`,
        [human.userId, human.sessionId],
      );
      if (live.rows.length !== 1)
        throw new ProjectAccessError('NOT_AUTHENTICATED');
      const result = await work(client, human);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async #project(client: Client, projectId: string): Promise<ProjectRow> {
    uuid(projectId);
    const result = await client.query<ProjectRow>(
      `select p.id,p.tenant_id,p.name_zh_cn,p.name_en,
    coalesce(s.requests_enabled,false) requests_enabled,statement_timestamp() now
    from platform.projects p join platform.tenants t on t.id=p.tenant_id
    left join platform_private.project_access_settings s on s.project_id=p.id
    where p.id=$1 and p.status='active' and t.status='active' for update of p`,
      [projectId],
    );
    if (!result.rows[0]) throw new ProjectAccessError('NOT_AUTHORIZED');
    return result.rows[0];
  }
  async #context(
    client: Client,
    human: VerifiedSupabaseJwtClaims,
    project: ProjectRow,
  ): Promise<AuthorizedContext | null> {
    return createPostgresAuthorizationContextLoader((sql, values) =>
      client.query<AuthorizationRow>(sql, values),
    )({
      actorId: human.userId,
      sessionId: human.sessionId,
      tenantId: project.tenant_id,
      projectId: project.id,
      purpose: 'project-access',
    });
  }
  async #manager(
    client: Client,
    human: VerifiedSupabaseJwtClaims,
    project: ProjectRow,
  ): Promise<AuthorizedContext> {
    const context = await this.#context(client, human, project);
    if (!context?.scopes.includes('platform.membership.manage'))
      throw new ProjectAccessError('NOT_AUTHORIZED');
    return context;
  }
  async #member(
    client: Client,
    projectId: string,
    actorId: string,
  ): Promise<ProjectAccessMemberView | null> {
    const result = await client.query<MemberRow>(
      MEMBER_SELECT + ' where m.project_id=$1 and m.actor_id=$2',
      [projectId, actorId],
    );
    return result.rows[0] ? memberView(result.rows[0]) : null;
  }
  async projects(
    input: SessionInput & { readonly page: ProjectAccessPage },
  ): Promise<{ items: ProjectAccessProjectView[]; hasMore: boolean }> {
    const page = ProjectAccessPageSchema.parse(input.page);
    return this.#transaction(input.token, async (client, human) => {
      const rows = await client.query<ProjectRow>(
        `select p.id,p.tenant_id,p.name_zh_cn,p.name_en,
    coalesce(s.requests_enabled,false) requests_enabled,statement_timestamp() now
    from platform.projects p join platform.tenants t on t.id=p.tenant_id
    left join platform_private.project_access_settings s on s.project_id=p.id
    where p.status='active' and t.status='active'
    and (s.requests_enabled or exists(select 1 from platform.project_memberships m where m.project_id=p.id and m.actor_id=$1))
    and (p.name_zh_cn ilike '%'||$2||'%' or p.name_en ilike '%'||$2||'%')
    order by p.id limit $3 offset $4`,
        [human.userId, page.search, page.limit + 1, page.offset],
      );
      const items: ProjectAccessProjectView[] = [];
      for (const project of rows.rows.slice(0, page.limit)) {
        const context = await this.#context(client, human, project);
        const member = await this.#member(client, project.id, human.userId);
        const roleRows = await client.query<{
          role_key: string;
          max_days: number;
          scopes: string[];
        }>(
          `select r.role_key,ar.max_days,
     coalesce(array_agg(rs.scope) filter(where rs.scope is not null),'{}') scopes
     from platform_private.project_access_roles ar join platform.roles r on r.id=ar.role_id
     left join platform.role_scopes rs on rs.role_id=r.id
     where ar.project_id=$1 and r.status='active' and not exists(select 1 from platform.role_scopes x where x.role_id=r.id and x.scope like 'platform.%')
     group by r.id,ar.max_days order by r.role_key`,
          [project.id],
        );
        items.push({
          projectId: project.id,
          tenantId: project.tenant_id,
          nameZh: project.name_zh_cn,
          nameEn: project.name_en,
          canManage:
            context?.scopes.includes('platform.membership.manage') ?? false,
          canApprove:
            context?.scopes.includes('platform.access.approve') ?? false,
          requestsEnabled: project.requests_enabled,
          memberStatus: member?.status ?? null,
          expiresAt: member?.expiresAt ?? null,
          roles: context?.roles ?? [],
          assignableRoles: roleRows.rows.map((r) => ({
            roleKey: r.role_key,
            maxDays: r.max_days,
            scopes: r.scopes,
          })),
        });
      }
      return { items, hasMore: rows.rows.length > page.limit };
    });
  }
  async members(
    input: SessionInput & {
      readonly projectId: string;
      readonly page: ProjectAccessPage;
    },
  ): Promise<{ items: ProjectAccessMemberView[]; hasMore: boolean }> {
    const page = ProjectAccessPageSchema.parse(input.page);
    return this.#transaction(input.token, async (client, human) => {
      const project = await this.#project(client, input.projectId);
      await this.#manager(client, human, project);
      const rows = await client.query<MemberRow>(
        MEMBER_SELECT +
          ` where m.project_id=$1 and
    (a.email ilike '%'||$2||'%' or u.display_name ilike '%'||$2||'%' or m.actor_id::text=$2)
    order by m.actor_id limit $3 offset $4`,
        [project.id, page.search, page.limit + 1, page.offset],
      );
      return {
        items: rows.rows.slice(0, page.limit).map(memberView),
        hasMore: rows.rows.length > page.limit,
      };
    });
  }
  async #write<T>(
    client: Client,
    human: VerifiedSupabaseJwtClaims,
    project: ProjectRow,
    key: string,
    action: string,
    command: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    uuid(key);
    const hash = createHash('sha256')
      .update(JSON.stringify({ action, command }))
      .digest('hex');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      human.userId + ':' + key,
    ]);
    const prior = await client.query<{ request_hash: string; result: T }>(
      'select request_hash,result from platform_private.project_access_mutations where actor_id=$1 and idempotency_key=$2',
      [human.userId, key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash)
        throw new ProjectAccessError('IDEMPOTENCY_CONFLICT');
      return prior.rows[0].result;
    }
    const result = await work();
    await client.query(
      `insert into platform_private.project_access_mutations(actor_id,idempotency_key,project_id,request_hash,result) values($1,$2,$3,$4,$5::jsonb)`,
      [human.userId, key, project.id, hash, JSON.stringify(result)],
    );
    return result;
  }
  async grant(
    input: WriteInput<ProjectAccessGrant>,
  ): Promise<ProjectAccessMemberView> {
    const command = ProjectAccessGrantSchema.parse(input.command);
    return this.#transaction(input.token, async (client, human) => {
      const project = await this.#project(client, command.projectId);
      const context = await this.#manager(client, human, project);
      return this.#write(
        client,
        human,
        project,
        input.idempotencyKey,
        'grant',
        command,
        async () => {
          const roleResult = await client.query<{
            id: string;
            role_key: string;
            max_security_level: AuthorizedContext['maxSecurityLevel'];
            scopes: string[];
            max_days: number;
          }>(
            `select r.id,r.role_key,r.max_security_level,ar.max_days,
     coalesce(array_agg(rs.scope) filter(where rs.scope is not null),'{}') scopes
     from platform_private.project_access_roles ar join platform.roles r on r.id=ar.role_id
     left join platform.role_scopes rs on rs.role_id=r.id
     where ar.project_id=$1 and r.role_key=$2 and r.status='active' group by r.id,ar.max_days`,
            [project.id, command.roleKey],
          );
          const role = roleResult.rows[0];
          if (!role) throw new ProjectAccessError('ROLE_NOT_ASSIGNABLE');
          const bound = await client.query<{ expiry: Date | null }>(
            `select min(expiry) expiry from (
     select expires_at expiry from platform.tenant_memberships where tenant_id=$1 and actor_id=$3
     union all select expires_at from platform.project_memberships where project_id=$2 and actor_id=$3
     union all select expires_at from platform.role_bindings where actor_id=$3 and tenant_id=$1 and (project_id is null or project_id=$2)
      and status='active' and effective_at<=statement_timestamp() and (expires_at is null or expires_at>statement_timestamp())) x`,
            [project.tenant_id, project.id, human.userId],
          );
          const error = checkProjectGrant({
            actorId: human.userId,
            targetActorId: command.actorId,
            action: 'manage',
            scopes: context.scopes,
            role: {
              key: role.role_key,
              active: true,
              scopes: role.scopes,
              securityLevel: role.max_security_level,
            },
            policy: { roleKey: role.role_key, maxDays: role.max_days },
            managerSecurityLevel: context.maxSecurityLevel,
            managerExpiresAt: bound.rows[0]?.expiry?.toISOString() ?? null,
            expiresAt: command.expiresAt,
            now: project.now.getTime(),
          });
          if (error) throw new ProjectAccessError(error);
          const previous = await this.#member(
            client,
            project.id,
            command.actorId,
          );
          if ((previous?.version ?? 0) !== command.expectedVersion)
            throw new ProjectAccessError('VERSION_CONFLICT');
          const privilegedTarget = await client.query(
            `select 1 from platform.role_bindings b join platform.roles r on r.id=b.role_id
             join platform.role_scopes s on s.role_id=r.id
             where b.actor_id=$1 and b.tenant_id=$2 and (b.project_id is null or b.project_id=$3)
             and b.status='active' and r.status='active' and s.scope like 'platform.%'
             and b.effective_at<=statement_timestamp()
             and (b.expires_at is null or b.expires_at>statement_timestamp()) limit 1`,
            [command.actorId, project.tenant_id, project.id],
          );
          if (previous?.protected || privilegedTarget.rows.length > 0)
            throw new ProjectAccessError('PROTECTED_MEMBER');
          const actor = await client.query(
            `select id from platform.actors where id=$1 and actor_type='human' and status='active' for share`,
            [command.actorId],
          );
          if (!actor.rows[0])
            throw new ProjectAccessError('MEMBER_UNAVAILABLE');
          const tenantMember = await client.query<{
            status: string;
            effective_at: Date;
            expires_at: Date | null;
          }>(
            `select status,effective_at,expires_at from platform.tenant_memberships where tenant_id=$1 and actor_id=$2 for update`,
            [project.tenant_id, command.actorId],
          );
          const tm = tenantMember.rows[0];
          if (
            tm &&
            (tm.status !== 'active' ||
              tm.effective_at > project.now ||
              (tm.expires_at !== null && tm.expires_at <= project.now))
          )
            throw new ProjectAccessError('MEMBER_UNAVAILABLE');
          if (tm?.expires_at && tm.expires_at < new Date(command.expiresAt))
            throw new ProjectAccessError('INVALID_EXPIRY');
          await client.query(
            `insert into platform.tenant_memberships(tenant_id,actor_id) values($1,$2) on conflict do nothing`,
            [project.tenant_id, command.actorId],
          );
          // Reactivation must not revive other old project grants.
          if (previous && previous.status !== 'active')
            await client.query(
              `update platform.role_bindings set status='revoked',updated_at=statement_timestamp() where project_id=$1 and actor_id=$2 and status<>'revoked'`,
              [project.id, command.actorId],
            );
          await client.query(
            `insert into platform.project_memberships(project_id,tenant_id,actor_id,expires_at) values($1,$2,$3,$4)
     on conflict(project_id,actor_id) do update set status='active',effective_at=statement_timestamp(),expires_at=excluded.expires_at,
      membership_version=platform.project_memberships.membership_version+1,updated_at=statement_timestamp()`,
            [project.id, project.tenant_id, command.actorId, command.expiresAt],
          );
          await client.query(
            `update platform.role_bindings set status='revoked',updated_at=statement_timestamp() where project_id=$1 and actor_id=$2 and role_id=$3 and status<>'revoked'`,
            [project.id, command.actorId, role.id],
          );
          await client.query(
            `insert into platform.role_bindings(id,actor_id,tenant_id,project_id,role_id,expires_at,created_by_actor_id) values($1,$2,$3,$4,$5,$6,$7)`,
            [
              randomUUID(),
              command.actorId,
              project.tenant_id,
              project.id,
              role.id,
              command.expiresAt,
              human.userId,
            ],
          );
          await this.#advanceAuthorization(client, project, command.actorId);
          const result = await this.#member(
            client,
            project.id,
            command.actorId,
          );
          if (!result) throw new ProjectAccessError('MEMBER_UNAVAILABLE');
          await this.#audit(
            client,
            human,
            project,
            command.actorId,
            'grant',
            command.reason,
            previous,
            result,
          );
          return result;
        },
      );
    });
  }
  async #audit(
    client: Client,
    human: VerifiedSupabaseJwtClaims,
    project: ProjectRow,
    subjectId: string,
    action: string,
    reason: string,
    before: unknown,
    after: unknown,
  ) {
    const eventId = randomUUID();
    await client.query(
      `insert into platform_private.project_access_events(project_id,actor_id,subject_id,action,reason,before_state,after_state,id) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        project.id,
        human.userId,
        subjectId,
        action,
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
        eventId,
      ],
    );
    const safeContext = JSON.stringify({ eventId, subjectId, action });
    await client.query(
      `insert into platform_private.authorization_audit_events(actor_id,tenant_id,project_id,capability,purpose,decision,reason_code,resource_type,resource_id,context)
       values($1,$2,$3,'platform.membership.manage','project-access','allowed',$4,'project-member',$5,$6::jsonb)`,
      [
        human.userId,
        project.tenant_id,
        project.id,
        action,
        subjectId,
        safeContext,
      ],
    );
    await client.query(
      `insert into platform_private.control_outbox(aggregate_type,aggregate_id,event_type,payload,idempotency_key)
       values('project',$1,$2,$3::jsonb,$4)`,
      [
        project.id,
        'project.member.' + action,
        safeContext,
        'project-access:' + eventId,
      ],
    );
  }
  async revoke(
    input: WriteInput<ProjectAccessRevoke>,
  ): Promise<ProjectAccessMemberView> {
    const command = ProjectAccessRevokeSchema.parse(input.command);
    return this.#transaction(input.token, async (client, human) => {
      const project = await this.#project(client, command.projectId);
      const context = await this.#manager(client, human, project);
      return this.#write(
        client,
        human,
        project,
        input.idempotencyKey,
        'revoke',
        command,
        async () => {
          const previous = await this.#member(
            client,
            project.id,
            command.actorId,
          );
          if (!previous) throw new ProjectAccessError('MEMBER_UNAVAILABLE');
          const error = checkProjectRemoval({
            actorId: human.userId,
            targetActorId: command.actorId,
            scopes: context.scopes,
            targetHasManagementAuthority: previous.protected,
          });
          if (error) throw new ProjectAccessError(error);
          if (previous.version !== command.expectedVersion)
            throw new ProjectAccessError('VERSION_CONFLICT');
          await client.query(
            `update platform.project_memberships set status='revoked',membership_version=membership_version+1,updated_at=statement_timestamp() where project_id=$1 and actor_id=$2`,
            [project.id, command.actorId],
          );
          await client.query(
            `update platform.role_bindings set status='revoked',updated_at=statement_timestamp() where project_id=$1 and actor_id=$2 and status<>'revoked'`,
            [project.id, command.actorId],
          );
          await this.#advanceAuthorization(client, project, command.actorId);
          const result = await this.#member(
            client,
            project.id,
            command.actorId,
          );
          if (!result) throw new ProjectAccessError('MEMBER_UNAVAILABLE');
          await this.#audit(
            client,
            human,
            project,
            command.actorId,
            'revoke',
            command.reason,
            previous,
            result,
          );
          return result;
        },
      );
    });
  }
}
