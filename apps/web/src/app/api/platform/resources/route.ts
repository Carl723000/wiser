import { PlatformUuidSchema } from '@wiser/platform-contracts';
import { ExplorationQueryInputSchema } from '@wiser/data-contracts';
import {
  getDataFoundationDal,
  DataFoundationApiError,
} from '@/lib/data-foundation-dal.server';

const fields = new Set([
  'tenantId',
  'projectId',
  'queryId',
  'after',
  'text',
  'kind',
  'records',
  'spatial',
]);
const headers = { 'cache-control': 'private, no-store' };
const fail = (status: number) =>
  Response.json({ code: 'RESOURCE_COVERAGE_UNAVAILABLE' }, { status, headers });

export async function GET(request: Request): Promise<Response> {
  if (request.url.length > 8192) return fail(400);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    return fail(400);
  if ([...params.keys()].some((key) => !fields.has(key))) return fail(400);
  const tenant = PlatformUuidSchema.safeParse(params.get('tenantId'));
  const project = PlatformUuidSchema.safeParse(params.get('projectId'));
  if (!tenant.success || !project.success) return fail(400);
  const { queryId, after, text, kind, records, spatial } =
    Object.fromEntries(params);
  if (
    queryId !== undefined &&
    [text, kind, records, spatial].some((value) => value !== undefined)
  )
    return fail(400);
  const spec = {
    ...(text !== undefined ? { text } : {}),
    ...(kind !== undefined ? { kinds: [kind] } : {}),
    ...(records !== undefined || spatial !== undefined
      ? {
          readiness: {
            ...(records !== undefined ? { records: [records] } : {}),
            ...(spatial !== undefined ? { spatial: [spatial] } : {}),
          },
        }
      : {}),
  };
  const input = ExplorationQueryInputSchema.safeParse({
    view: 'resources',
    first: 20,
    ...(queryId === undefined ? { spec } : { queryId }),
    ...(after === undefined ? {} : { after }),
  });
  if (!input.success) return fail(400);
  try {
    // These identifiers select a context, never confer permission. The API validates the current session's membership and Data scopes.
    const dal = await getDataFoundationDal({
      tenantId: tenant.data,
      projectId: project.data,
    });
    return Response.json(await dal.explore(input.data), { headers });
  } catch (error) {
    return fail(error instanceof DataFoundationApiError ? error.status : 503);
  }
}
