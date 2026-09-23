import { randomUUID } from 'node:crypto';
import {
  ResourcePolicyRequestViewSchema,
  ResourcePolicyRequestsPageSchema,
  resourceAccessReferenceKey,
  type ResourcePolicyProposal,
  type ResourcePolicyAction,
  type ResourcePolicyDecision,
  type ResourcePolicyRevoke,
  type ResourcePolicyRequestView,
  type ResourcePolicyRequestsQuery,
  type ResourcePolicyRequestsPage,
  type ResourcePolicyRevokeReceipt,
  type PlatformRequestContext,
  type AuthorizedContext,
} from '@wiser/platform-contracts';
import type { ResourceAdministrationSession } from './resource-batch-service.js';
import type { ResourceAdministrationOptions } from './resource-administration-service.js';
import { issueResourceManagementPermit } from './resource-management-policy.js';
import {
  createPostgresAuthorizationContextLoader,
  type AuthorizationRow,
} from './postgres-authorization.js';
import { resourceAdministrationFailure as fail } from './resource-administration-error.js';
interface RequestRow {
  id: string;
  project_id: string;
  policy_id: string;
  expected_policy_version: number;
  resource: ResourcePolicyProposal['resource'];
  allowed_actions: ResourcePolicyProposal['allowedActions'];
  management_roles: string[];
  license_basis: string;
  starts_at: Date;
  expires_at: Date;
  max_grant_days: number;
  reason: string;
  applicant_id: string;
  applicant_session_id: string;
  status: ResourcePolicyRequestView['status'];
  version: number;
  decided_by: string | null;
  decision_reason: string | null;
  published_version: number | null;
  created_at: Date;
  decided_at: Date | null;
}
function view(r: RequestRow): ResourcePolicyRequestView {
  return ResourcePolicyRequestViewSchema.parse({
    id: r.id,
    projectId: r.project_id,
    policyId: r.policy_id,
    expectedPolicyVersion: r.expected_policy_version,
    resource: r.resource,
    allowedActions: r.allowed_actions,
    managementRoles: r.management_roles,
    licenseBasis: r.license_basis,
    startsAt: r.starts_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    maxGrantDays: r.max_grant_days,
    reason: r.reason,
    applicantId: r.applicant_id,
    status: r.status,
    version: r.version,
    decidedBy: r.decided_by,
    decisionReason: r.decision_reason,
    publishedVersion: r.published_version,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at?.toISOString() ?? null,
  });
}
export class ResourcePolicyStore {
  constructor(
    private readonly session: ResourceAdministrationSession,
    private readonly validatePackage: ResourceAdministrationOptions['validatePackage'],
  ) {}
  async authority(
    auth: AuthorizedContext = this.session.context.authorization,
  ) {
    const result = await this.session.client.query<{
      can_propose: boolean;
      can_approve: boolean;
    }>(
      'select can_propose,can_approve from platform_private.resource_policy_roles where project_id=$1 and active and role_key=any($2::text[]) for share',
      [this.session.project.id, auth.roles],
    );
    return {
      canPropose:
        auth.scopes.includes('platform.membership.manage') &&
        result.rows.some((r) => r.can_propose),
      canApprove:
        auth.scopes.includes('platform.access.approve') &&
        result.rows.some((r) => r.can_approve),
    };
  }
  async requireAuthority(kind: 'propose' | 'approve' | 'read') {
    const rights = await this.authority();
    if (
      kind === 'propose'
        ? !rights.canPropose
        : kind === 'approve'
          ? !rights.canApprove
          : !(rights.canPropose || rights.canApprove)
    )
      fail('NOT_AUTHORIZED');
    return rights;
  }
  async list(
    page: ResourcePolicyRequestsQuery,
  ): Promise<ResourcePolicyRequestsPage> {
    const rights = await this.requireAuthority('read');
    const now = (
      await this.session.client.query<{ now: Date }>(
        'select statement_timestamp() now',
      )
    ).rows[0]!.now;
    const result = await this.session.client.query<
      RequestRow & {
        publication_state: ResourcePolicyRequestsPage['items'][number]['publicationState'];
      }
    >(
      `select r.*, case
        when r.status<>'published' then 'none'
        when exists(select 1 from platform_private.resource_policy_versions v where v.project_id=r.project_id and v.policy_id=r.policy_id and v.version>r.published_version) then 'superseded'
        when exists(select 1 from platform_private.resource_policy_revocations x where x.project_id=r.project_id and x.policy_id=r.policy_id and x.version=r.published_version) then 'revoked'
        when r.expires_at<=$5 then 'expired'
        when r.starts_at>$5 then 'scheduled'
        else 'active' end publication_state
       from platform_private.resource_policy_requests r where project_id=$1 and ($2::text is null or status=$2) order by created_at desc,id desc offset $3 limit $4`,
      [
        this.session.project.id,
        page.status ?? null,
        page.offset,
        page.limit + 1,
        now,
      ],
    );
    return ResourcePolicyRequestsPageSchema.parse({
      ...rights,
      items: result.rows.slice(0, page.limit).map((row) => ({
        ...view(row),
        publicationState: row.publication_state,
      })),
      hasMore: result.rows.length > page.limit,
      checkedAt: now.toISOString(),
    });
  }
  async #current(command: ResourcePolicyProposal) {
    const result = await this.session.client.query<{
      policy_id: string;
      version: number;
      resource: ResourcePolicyProposal['resource'];
    }>(
      'select policy_id,version,resource from platform_private.resource_policy_versions where project_id=$1 and (policy_id=$2 or resource_key=$3) order by version desc limit 1',
      [
        this.session.project.id,
        command.policyId,
        command.resource.kind === 'version'
          ? `v:${command.resource.dataItemId.toLowerCase()}:${command.resource.versionId.toLowerCase()}`
          : `s:${command.resource.sourceId}`,
      ],
    );
    const last = result.rows[0];
    if (
      (last?.version ?? 0) !== command.expectedPolicyVersion ||
      (last &&
        (last.policy_id !== command.policyId ||
          resourceAccessReferenceKey(last.resource) !==
            resourceAccessReferenceKey(command.resource)))
    )
      fail('VERSION_CONFLICT');
  }
  async #validate(
    command: ResourcePolicyProposal,
    context = this.session.context,
  ) {
    const now = (
      await this.session.client.query<{ now: Date }>(
        'select statement_timestamp() now',
      )
    ).rows[0]!.now;
    if (Date.parse(command.expiresAt) <= now.getTime())
      fail('RESOURCE_UNAVAILABLE');
    const resources = [command.resource],
      actions = command.allowedActions;
    // A separately appointed source steward may inspect fixed-version metadata before any source policy exists.
    // This process-local token is not authority to publish a policy or access its content.
    const managementPermit = issueResourceManagementPermit(
      context,
      resources,
      actions,
      new Date(now.getTime() + 5000).toISOString(),
      'source-policy-proposal',
    );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const valid = await Promise.race([
        this.validatePackage({
          context,
          command: {
            projectId: command.projectId,
            packageId: command.policyId,
            expectedVersion: command.expectedPolicyVersion,
            name: 'Source permission metadata validation',
            resources,
            allowedActions: actions,
            licenseBasis: command.licenseBasis,
            reason: command.reason,
          },
          managementPermit,
          signal: controller.signal,
        }),
        new Promise<boolean>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error('unavailable'));
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
  }
  async propose(
    command: ResourcePolicyProposal,
  ): Promise<ResourcePolicyRequestView> {
    await this.requireAuthority('propose');
    await this.#current(command);
    await this.#validate(command);
    const result = await this.session.client.query<RequestRow>(
      `insert into platform_private.resource_policy_requests(project_id,policy_id,expected_policy_version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,reason,applicant_id,applicant_session_id)
  values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [
        this.session.project.id,
        command.policyId,
        command.expectedPolicyVersion,
        JSON.stringify(command.resource),
        command.allowedActions,
        command.managementRoles,
        command.licenseBasis,
        command.startsAt,
        command.expiresAt,
        command.maxGrantDays,
        command.reason,
        this.session.human.userId,
        this.session.human.sessionId,
      ],
    );
    const after = view(result.rows[0]!);
    await this.#audit('source.propose', after.id, command.reason, {}, after);
    return after;
  }
  async #request(command: ResourcePolicyAction): Promise<RequestRow> {
    const r = (
      await this.session.client.query<RequestRow>(
        'select * from platform_private.resource_policy_requests where project_id=$1 and id=$2 for update',
        [this.session.project.id, command.requestId],
      )
    ).rows[0];
    if (!r) fail('REQUEST_UNAVAILABLE');
    if (r.version !== command.expectedVersion) fail('VERSION_CONFLICT');
    if (r.status !== 'pending') fail('REQUEST_STATE_CONFLICT');
    return r;
  }
  async #applicant(r: RequestRow): Promise<PlatformRequestContext> {
    const live = await this.session.client.query(
      "select a.id from platform.actors a join auth.sessions s on s.user_id=a.auth_user_id where s.id=$1 and a.id=$2 and a.actor_type='human' and a.status='active' and s.oauth_client_id is null and (s.not_after is null or s.not_after>statement_timestamp()) for share of a,s",
      [r.applicant_session_id, r.applicant_id],
    );
    if (live.rows.length !== 1) fail('AUTHORITY_CHANGED');
    const authorization = await createPostgresAuthorizationContextLoader(
      (sql, values) => this.session.client.query<AuthorizationRow>(sql, values),
    )({
      actorId: r.applicant_id,
      sessionId: r.applicant_session_id,
      tenantId: this.session.project.tenant_id,
      projectId: this.session.project.id,
      purpose: 'web-console',
    });
    if (!authorization || !(await this.authority(authorization)).canPropose)
      fail('AUTHORITY_CHANGED');
    return {
      principal: {
        actorType: 'human',
        actorId: r.applicant_id,
        authUserId: r.applicant_id,
        sessionId: r.applicant_session_id,
        authenticationMethod: 'supabase_jwt',
      },
      authorization,
      traceId: randomUUID().replaceAll('-', ''),
    };
  }
  async decide(
    command: ResourcePolicyDecision,
  ): Promise<ResourcePolicyRequestView> {
    await this.requireAuthority('approve');
    const r = await this.#request(command),
      before = view(r);
    if (r.applicant_id === this.session.human.userId)
      fail('SELF_CHANGE_FORBIDDEN');
    if (command.decision === 'publish') {
      const proposal: ResourcePolicyProposal = {
        projectId: r.project_id,
        policyId: r.policy_id,
        expectedPolicyVersion: r.expected_policy_version,
        resource: r.resource,
        allowedActions: r.allowed_actions,
        managementRoles: r.management_roles,
        licenseBasis: r.license_basis,
        startsAt: r.starts_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        maxGrantDays: r.max_grant_days,
        reason: r.reason,
      };
      await this.#current(proposal);
      await this.#validate(proposal, await this.#applicant(r));
      await this.#validate(proposal);
      await this.session.client.query(
        `insert into platform_private.resource_policy_versions(project_id,policy_id,version,resource,allowed_actions,management_roles,license_basis,starts_at,expires_at,max_grant_days,created_by,approved_by)
    values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          r.project_id,
          r.policy_id,
          r.expected_policy_version + 1,
          JSON.stringify(r.resource),
          r.allowed_actions,
          r.management_roles,
          r.license_basis,
          r.starts_at,
          r.expires_at,
          r.max_grant_days,
          r.applicant_id,
          this.session.human.userId,
        ],
      );
    }
    const result = await this.session.client.query<RequestRow>(
      `update platform_private.resource_policy_requests set status=$3,version=version+1,decided_by=$4,decided_at=statement_timestamp(),decision_reason=$5,published_version=$6,updated_at=statement_timestamp() where project_id=$1 and id=$2 returning *`,
      [
        this.session.project.id,
        r.id,
        command.decision === 'publish' ? 'published' : 'rejected',
        this.session.human.userId,
        command.reason,
        command.decision === 'publish' ? r.expected_policy_version + 1 : null,
      ],
    );
    const after = view(result.rows[0]!);
    await this.#audit(
      command.decision === 'publish' ? 'source.publish' : 'source.reject',
      r.id,
      command.reason,
      before,
      after,
    );
    return after;
  }
  async withdraw(
    command: ResourcePolicyAction,
  ): Promise<ResourcePolicyRequestView> {
    await this.requireAuthority('propose');
    const r = await this.#request(command);
    if (r.applicant_id !== this.session.human.userId) fail('NOT_AUTHORIZED');
    const result = await this.session.client.query<RequestRow>(
      "update platform_private.resource_policy_requests set status='withdrawn',version=version+1,updated_at=statement_timestamp() where project_id=$1 and id=$2 returning *",
      [this.session.project.id, r.id],
    );
    const after = view(result.rows[0]!);
    await this.#audit('source.withdraw', r.id, command.reason, view(r), after);
    return after;
  }
  async revoke(
    command: ResourcePolicyRevoke,
  ): Promise<ResourcePolicyRevokeReceipt> {
    await this.requireAuthority('propose');
    const latest = (
      await this.session.client.query<{ version: number }>(
        'select version from platform_private.resource_policy_versions where project_id=$1 and policy_id=$2 order by version desc limit 1',
        [this.session.project.id, command.policyId],
      )
    ).rows[0];
    if (!latest) fail('RESOURCE_UNAVAILABLE');
    if (latest.version !== command.policyVersion) fail('VERSION_CONFLICT');
    const result = await this.session.client.query(
      `insert into platform_private.resource_policy_revocations(project_id,policy_id,version,revoked_by,reason) values($1,$2,$3,$4,$5) on conflict do nothing returning policy_id`,
      [
        this.session.project.id,
        command.policyId,
        command.policyVersion,
        this.session.human.userId,
        command.reason,
      ],
    );
    const receipt: ResourcePolicyRevokeReceipt = {
      policyId: command.policyId,
      policyVersion: command.policyVersion,
      status: 'revoked',
    };
    if (result.rows.length)
      await this.#audit(
        'source.revoke',
        command.policyId,
        command.reason,
        { version: command.policyVersion },
        receipt,
      );
    return receipt;
  }
  async #audit(
    action: string,
    id: string,
    reason: string,
    before: unknown,
    after: unknown,
  ) {
    await this.session.client.query(
      'insert into platform_private.resource_access_events(project_id,actor_id,action,subject_id,reason,before_state,after_state) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
      [
        this.session.project.id,
        this.session.human.userId,
        action,
        id,
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
      ],
    );
  }
}
