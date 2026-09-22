import 'server-only';
import {
  ResourceBatchesQuerySchema,
  ResourceBatchesPageSchema,
  ResourceBatchPreviewCommandSchema,
  ResourceBatchDecisionSchema,
  ResourceBatchActionSchema,
  ResourceBatchViewSchema,
  type ResourceBatchesQuery,
  type ResourceBatchPreviewCommand,
  type ResourceBatchDecision,
  type ResourceBatchAction,
  ResourceDefinitionsQuerySchema,
  ResourceDefinitionsPageSchema,
  ResourcePackageCommandSchema,
  ResourcePresetCommandSchema,
  ResourceDefinitionReceiptSchema,
  type ResourceDefinitionsQuery,
  type ResourcePackageCommand,
  type ResourcePresetCommand,
  ProjectAccessRequestSchema,
  ProjectAccessRequestActionSchema,
  ProjectAccessRequestDecisionSchema,
  ProjectAccessRequestWithdrawalSchema,
  ProjectAccessRequestViewSchema,
  ProjectAccessRequestsPageSchema,
  ProjectAccessEventsPageSchema,
  type ProjectAccessRequest,
  type ProjectAccessRequestAction,
  type ProjectAccessRequestDecision,
  type ProjectAccessRequestWithdrawal,
  PlatformUuidSchema,
  ProjectAccessPageSchema,
  ProjectAccessGrantSchema,
  ProjectAccessInviteSchema,
  ProjectAccessInvitationDeliverySchema,
  ProjectAccessInvitationViewSchema,
  ProjectAccessInvitationsPageSchema,
  type ProjectAccessInvite,
  type ProjectAccessInvitationDelivery,
  ProjectAccessRevokeSchema,
  ProjectAccessProjectsPageSchema,
  ProjectAccessMembersPageSchema,
  ProjectAccessMemberViewSchema,
  type ProjectAccessPage,
  type ProjectAccessGrant,
  type ProjectAccessRevoke,
} from '@wiser/platform-contracts';
import { verifiedSessionAccessToken } from './supabase/verified-session';
import { createWiserServerSupabaseClient } from './supabase/server';

const errorCodes = new Set([
  'PREVIEW_EXPIRED',
  'REQUEST_STATE_CONFLICT',
  'MEMBERSHIP_CHANGED',
  'AUTHORITY_CHANGED',
  'IMPORTANT_APPROVAL_REQUIRED',
  'SELF_CHANGE_FORBIDDEN',
  'NOT_AUTHENTICATED',
  'NOT_AUTHORIZED',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_EXPIRY',
  'SELF_CHANGE_FORBIDDEN',
  'ROLE_NOT_ASSIGNABLE',
  'PROTECTED_MEMBER',
  'MEMBER_UNAVAILABLE',
  'INVITATION_UNAVAILABLE',
  'DELIVERY_IN_PROGRESS',
  'REQUEST_UNAVAILABLE',
  'REQUEST_ALREADY_PENDING',
  'REQUEST_STATE_CONFLICT',
  'VALIDATION_FAILED',
  'RESOURCE_POLICY_NOT_ENABLED',
  'RESOURCE_UNAVAILABLE',
]);
export class ProjectAccessWebError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Invalid response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 524288) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(result),
  ) as unknown;
}
export function createProjectAccessClient(options: {
  origin: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
}) {
  const url = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ProjectAccessWebError('ACCESS_UNAVAILABLE', 503);
  const fetcher = options.fetch ?? fetch;
  async function call<T>(
    path: string,
    schema: { parse(input: unknown): T },
    body?: unknown,
    key?: string,
  ): Promise<T> {
    const token = await options.token();
    try {
      const response = await fetcher(
        new URL('/api/platform/v1/access/' + path, url),
        {
          method: body === undefined ? 'GET' : 'POST',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Idempotency-Key': key!,
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      const data = await boundedJson(response);
      if (!response.ok) {
        const code =
          typeof data === 'object' &&
          data !== null &&
          'code' in data &&
          typeof data.code === 'string'
            ? data.code
            : null;
        if (code !== null && errorCodes.has(code))
          throw new ProjectAccessWebError(code, response.status);
        throw new Error('Upstream unavailable');
      }
      return schema.parse(data);
    } catch (error) {
      if (error instanceof ProjectAccessWebError) throw error;
      throw new ProjectAccessWebError('ACCESS_UNAVAILABLE', 503);
    }
  }
  function pageQuery(input: ProjectAccessPage) {
    const p = ProjectAccessPageSchema.parse(input);
    return new URLSearchParams({
      offset: String(p.offset),
      limit: String(p.limit),
      search: p.search,
    });
  }
  return {
    batches(id: string, input: ResourceBatchesQuery) {
      PlatformUuidSchema.parse(id);
      const p = ResourceBatchesQuerySchema.parse(input);
      const query = new URLSearchParams({
        offset: String(p.offset),
        limit: String(p.limit),
        ...(p.status ? { status: p.status } : {}),
      });
      return call(
        `projects/${id}/resource-batches?${query}`,
        ResourceBatchesPageSchema,
      );
    },
    previewBatch(command: ResourceBatchPreviewCommand, key: string) {
      return call(
        'resource-batches/preview',
        ResourceBatchViewSchema,
        ResourceBatchPreviewCommandSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    decideBatch(command: ResourceBatchDecision, key: string) {
      return call(
        'resource-batches/decide',
        ResourceBatchViewSchema,
        ResourceBatchDecisionSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    executeBatch(command: ResourceBatchAction, key: string) {
      return call(
        'resource-batches/execute',
        ResourceBatchViewSchema,
        ResourceBatchActionSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    withdrawBatch(command: ResourceBatchAction, key: string) {
      return call(
        'resource-batches/withdraw',
        ResourceBatchViewSchema,
        ResourceBatchActionSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    definitions(id: string, input: ResourceDefinitionsQuery) {
      PlatformUuidSchema.parse(id);
      const page = ResourceDefinitionsQuerySchema.parse(input);
      const query = new URLSearchParams({
        kind: page.kind,
        offset: String(page.offset),
        limit: String(page.limit),
        search: page.search,
      });
      return call(
        `projects/${id}/resource-definitions?${query}`,
        ResourceDefinitionsPageSchema,
      );
    },
    savePackage(command: ResourcePackageCommand, key: string) {
      return call(
        'resource-packages',
        ResourceDefinitionReceiptSchema,
        ResourcePackageCommandSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    savePreset(command: ResourcePresetCommand, key: string) {
      return call(
        'resource-presets',
        ResourceDefinitionReceiptSchema,
        ResourcePresetCommandSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    requests(id: string, page: ProjectAccessPage) {
      PlatformUuidSchema.parse(id);
      return call(
        `projects/${id}/requests?${pageQuery(page)}`,
        ProjectAccessRequestsPageSchema,
      );
    },
    events(id: string, page: ProjectAccessPage) {
      PlatformUuidSchema.parse(id);
      return call(
        `projects/${id}/events?${pageQuery(page)}`,
        ProjectAccessEventsPageSchema,
      );
    },
    requestAccess(command: ProjectAccessRequest, key: string) {
      return call(
        'requests',
        ProjectAccessRequestViewSchema,
        ProjectAccessRequestSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    decideRequest(command: ProjectAccessRequestDecision, key: string) {
      return call(
        'request-decisions',
        ProjectAccessRequestViewSchema,
        ProjectAccessRequestDecisionSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    withdrawRequest(command: ProjectAccessRequestWithdrawal, key: string) {
      return call(
        'request-withdrawals',
        ProjectAccessRequestViewSchema,
        ProjectAccessRequestWithdrawalSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    executeRequest(command: ProjectAccessRequestAction, key: string) {
      return call(
        'request-executions',
        ProjectAccessRequestViewSchema,
        ProjectAccessRequestActionSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    projects(page: ProjectAccessPage) {
      return call(
        'projects?' + pageQuery(page).toString(),
        ProjectAccessProjectsPageSchema,
      );
    },
    async members(id: string, page: ProjectAccessPage) {
      PlatformUuidSchema.parse(id);
      return await call(
        `projects/${id}/members?${pageQuery(page)}`,
        ProjectAccessMembersPageSchema,
      );
    },
    invitations(id: string, page: ProjectAccessPage) {
      PlatformUuidSchema.parse(id);
      return call(
        `projects/${id}/invitations?${pageQuery(page)}`,
        ProjectAccessInvitationsPageSchema,
      );
    },
    invite(command: ProjectAccessInvite, key: string) {
      return call(
        'invitations',
        ProjectAccessInvitationViewSchema,
        ProjectAccessInviteSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    deliverInvitation(command: ProjectAccessInvitationDelivery, key: string) {
      return call(
        'invitation-deliveries',
        ProjectAccessInvitationViewSchema,
        ProjectAccessInvitationDeliverySchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    grant(command: ProjectAccessGrant, key: string) {
      return call(
        'grants',
        ProjectAccessMemberViewSchema,
        ProjectAccessGrantSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
    revoke(command: ProjectAccessRevoke, key: string) {
      return call(
        'revocations',
        ProjectAccessMemberViewSchema,
        ProjectAccessRevokeSchema.parse(command),
        PlatformUuidSchema.parse(key),
      );
    },
  };
}
export function getProjectAccessClient() {
  if (process.env.WISER_PROJECT_ACCESS_ENABLED !== 'true')
    throw new ProjectAccessWebError('ACCESS_UNAVAILABLE', 503);
  return createProjectAccessClient({
    origin:
      process.env.WISER_DATA_API_INTERNAL_URL ??
      process.env.AGENT_EXCON_API_INTERNAL_URL ??
      '',
    token: () =>
      verifiedSessionAccessToken(
        createWiserServerSupabaseClient,
        () => new Date(),
      ),
  });
}
