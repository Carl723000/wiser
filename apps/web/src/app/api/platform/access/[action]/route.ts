import {
  PlatformUuidSchema,
  ProjectAccessPageSchema,
  ProjectAccessGrantSchema,
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
  if (action !== 'projects' && action !== 'members')
    return fail(404, 'NOT_FOUND');
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const { projectId, ...pageInput } = query;
  const page = ProjectAccessPageSchema.safeParse(pageInput);
  if (
    !page.success ||
    (action === 'members' &&
      !PlatformUuidSchema.safeParse(projectId).success) ||
    (action === 'projects' && projectId !== undefined)
  )
    return fail(400, 'VALIDATION_FAILED');
  try {
    const client = getProjectAccessClient();
    return Response.json(
      action === 'projects'
        ? await client.projects(page.data)
        : await client.members(projectId, page.data),
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
  if (action !== 'grant' && action !== 'revoke') return fail(404, 'NOT_FOUND');
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
      if (bytes > 16384) {
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
