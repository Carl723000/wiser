import {
  ResourceBatchesQuerySchema,
  ResourceBatchPreviewCommandSchema,
  ResourceBatchDecisionSchema,
  ResourceBatchActionSchema,
  ResourceDefinitionsQuerySchema,
  ResourcePackageCommandSchema,
  ResourcePresetCommandSchema,
  ProjectAccessRequestSchema,
  ProjectAccessRequestActionSchema,
  ProjectAccessRequestDecisionSchema,
  ProjectAccessRequestWithdrawalSchema,
  PlatformUuidSchema,
  ProjectAccessPageSchema,
  ProjectAccessGrantSchema,
  ProjectAccessInviteSchema,
  ProjectAccessInvitationDeliverySchema,
  ProjectAccessRevokeSchema,
} from '@wiser/platform-contracts';
import {
  getProjectAccessClient,
  ProjectAccessWebError,
} from '@/lib/project-access.server';
import { VerifiedSessionError } from '@/lib/supabase/verified-session';
import { isSameOriginRequest } from '@/lib/request-origin';
const headers = { 'cache-control': 'private, no-store' };
const fail = (status: number, code: string) =>
  Response.json({ code }, { status, headers });
type Context = { params: Promise<{ action: string }> };
function failure(error: unknown) {
  if (error instanceof ProjectAccessWebError)
    return fail(error.status, error.code);
  if (error instanceof VerifiedSessionError)
    return fail(
      error.status,
      error.status === 401 ? 'NOT_AUTHENTICATED' : 'ACCESS_UNAVAILABLE',
    );
  return fail(503, 'ACCESS_UNAVAILABLE');
}
export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const { action } = await context.params;
  if (action === 'resource-batches') {
    const { projectId, ...input } = Object.fromEntries(
      new URL(request.url).searchParams,
    );
    const project = PlatformUuidSchema.safeParse(projectId),
      page = ResourceBatchesQuerySchema.safeParse(input);
    if (!project.success || !page.success)
      return fail(400, 'VALIDATION_FAILED');
    try {
      return Response.json(
        await getProjectAccessClient().batches(project.data, page.data),
        { headers },
      );
    } catch (error) {
      return failure(error);
    }
  }
  if (action === 'resource-definitions') {
    const { projectId, ...query } = Object.fromEntries(
      new URL(request.url).searchParams,
    );
    const page = ResourceDefinitionsQuerySchema.safeParse(query);
    const project = PlatformUuidSchema.safeParse(projectId);
    if (!page.success || !project.success)
      return fail(400, 'VALIDATION_FAILED');
    try {
      return Response.json(
        await getProjectAccessClient().definitions(project.data, page.data),
        { headers },
      );
    } catch (error) {
      return failure(error);
    }
  }
  if (
    action !== 'projects' &&
    action !== 'members' &&
    action !== 'invitations' &&
    action !== 'requests' &&
    action !== 'events'
  )
    return fail(404, 'NOT_FOUND');
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { projectId, ...pageInput } = query;
  const page = ProjectAccessPageSchema.safeParse(pageInput);
  if (
    !page.success ||
    (action !== 'projects' &&
      !PlatformUuidSchema.safeParse(projectId).success) ||
    (action === 'projects' && projectId !== undefined)
  )
    return fail(400, 'VALIDATION_FAILED');
  try {
    const client = getProjectAccessClient();
    return Response.json(
      action === 'projects'
        ? await client.projects(page.data)
        : action === 'members'
          ? await client.members(projectId, page.data)
          : action === 'invitations'
            ? await client.invitations(projectId, page.data)
            : action === 'requests'
              ? await client.requests(projectId, page.data)
              : await client.events(projectId, page.data),
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  if (!isSameOriginRequest(request)) return fail(403, 'NOT_AUTHORIZED');
  const { action } = await context.params;
  if (
    action !== 'grant' &&
    action !== 'revoke' &&
    action !== 'invite' &&
    action !== 'deliver-invitation' &&
    action !== 'request' &&
    action !== 'decide-request' &&
    action !== 'withdraw-request' &&
    action !== 'execute-request' &&
    action !== 'resource-package' &&
    action !== 'resource-preset' &&
    action !== 'resource-batch-preview' &&
    action !== 'resource-batch-decide' &&
    action !== 'resource-batch-execute' &&
    action !== 'resource-batch-withdraw'
  )
    return fail(404, 'NOT_FOUND');
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return fail(400, 'VALIDATION_FAILED');
  const reader = request.body?.getReader();
  if (!reader) return fail(400, 'VALIDATION_FAILED');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let body: unknown;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5000);
  try {
    while (true) {
      const part = await reader.read();
      if (timedOut) return fail(408, 'VALIDATION_FAILED');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > (action === 'resource-package' ? 262144 : 16384)) {
        await reader.cancel();
        return fail(413, 'VALIDATION_FAILED');
      }
      chunks.push(part.value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(data),
    ) as unknown;
  } catch {
    return fail(400, 'VALIDATION_FAILED');
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const key = PlatformUuidSchema.safeParse(
    request.headers.get('idempotency-key'),
  );
  if (!key.success) return fail(400, 'VALIDATION_FAILED');
  try {
    const client = getProjectAccessClient();
    if (action === 'resource-batch-preview') {
      const command = ResourceBatchPreviewCommandSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.previewBatch(command.data, key.data), {
        headers,
      });
    }
    if (action === 'resource-batch-decide') {
      const command = ResourceBatchDecisionSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.decideBatch(command.data, key.data), {
        headers,
      });
    }
    if (
      action === 'resource-batch-execute' ||
      action === 'resource-batch-withdraw'
    ) {
      const command = ResourceBatchActionSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(
        action === 'resource-batch-execute'
          ? await client.executeBatch(command.data, key.data)
          : await client.withdrawBatch(command.data, key.data),
        { headers },
      );
    }
    if (action === 'resource-package') {
      const command = ResourcePackageCommandSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.savePackage(command.data, key.data), {
        headers,
      });
    }
    if (action === 'resource-preset') {
      const command = ResourcePresetCommandSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.savePreset(command.data, key.data), {
        headers,
      });
    }
    if (action === 'request') {
      const command = ProjectAccessRequestSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.requestAccess(command.data, key.data), {
        headers,
      });
    }
    if (action === 'decide-request') {
      const command = ProjectAccessRequestDecisionSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.decideRequest(command.data, key.data), {
        headers,
      });
    }
    if (action === 'withdraw-request') {
      const command = ProjectAccessRequestWithdrawalSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(
        await client.withdrawRequest(command.data, key.data),
        { headers },
      );
    }
    if (action === 'execute-request') {
      const command = ProjectAccessRequestActionSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(
        await client.executeRequest(command.data, key.data),
        { headers },
      );
    }
    if (action === 'invite') {
      const command = ProjectAccessInviteSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.invite(command.data, key.data), {
        headers,
      });
    }
    if (action === 'deliver-invitation') {
      const command = ProjectAccessInvitationDeliverySchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(
        await client.deliverInvitation(command.data, key.data),
        { headers },
      );
    }
    if (action === 'grant') {
      const command = ProjectAccessGrantSchema.safeParse(body);
      if (!command.success) return fail(400, 'VALIDATION_FAILED');
      return Response.json(await client.grant(command.data, key.data), {
        headers,
      });
    }
    const command = ProjectAccessRevokeSchema.safeParse(body);
    if (!command.success) return fail(400, 'VALIDATION_FAILED');
    return Response.json(await client.revoke(command.data, key.data), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
