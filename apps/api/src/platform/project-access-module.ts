import {
  ProjectAccessError,
  type PostgresProjectAccessService,
} from '@wiser/platform-auth';
import {
  ProjectAccessGrantSchema,
  ProjectAccessMemberViewSchema,
  ProjectAccessMembersPageSchema,
  ProjectAccessProjectsPageSchema,
  ProjectAccessPageSchema,
  ProjectAccessRevokeSchema,
  PlatformUuidSchema,
} from '@wiser/platform-contracts';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WiserApiModule } from './modules.js';

export type ProjectAccessHttpService = Pick<
  PostgresProjectAccessService,
  'projects' | 'members' | 'grant' | 'revoke'
>;
const Params = z.strictObject({ projectId: PlatformUuidSchema });
function fail(reply: FastifyReply, status: number, code: string) {
  return reply.status(status).send({ code });
}
async function guarded(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (token: string) => Promise<unknown>,
) {
  reply.header('Cache-Control', 'private, no-store');
  const header = request.headers.authorization;
  const token =
    typeof header === 'string'
      ? /^Bearer ([^\s]+)$/.exec(header)?.[1]
      : undefined;
  if (!token) return fail(reply, 401, 'NOT_AUTHENTICATED');
  try {
    return await work(token);
  } catch (error) {
    if (error instanceof z.ZodError)
      return fail(reply, 400, 'VALIDATION_FAILED');
    if (error instanceof ProjectAccessError) {
      const status =
        error.code === 'NOT_AUTHENTICATED'
          ? 401
          : error.code === 'VALIDATION_FAILED' ||
              error.code === 'INVALID_EXPIRY'
            ? 400
            : error.code === 'VERSION_CONFLICT' ||
                error.code === 'IDEMPOTENCY_CONFLICT'
              ? 409
              : 403;
      return fail(reply, status, error.code);
    }
    return fail(reply, 503, 'ACCESS_UNAVAILABLE');
  }
}
export function createProjectAccessModule(
  service: ProjectAccessHttpService,
): WiserApiModule {
  return {
    id: 'platform.project-access',
    register(app) {
      app.get('/api/platform/v1/access/projects', (request, reply) =>
        guarded(request, reply, async (token) =>
          ProjectAccessProjectsPageSchema.parse(
            await service.projects({
              token,
              page: ProjectAccessPageSchema.parse(request.query),
            }),
          ),
        ),
      );
      app.get(
        '/api/platform/v1/access/projects/:projectId/members',
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ProjectAccessMembersPageSchema.parse(
              await service.members({
                token,
                projectId: Params.parse(request.params).projectId,
                page: ProjectAccessPageSchema.parse(request.query),
              }),
            ),
          ),
      );
      app.post('/api/platform/v1/access/grants', (request, reply) =>
        guarded(request, reply, async (token) =>
          ProjectAccessMemberViewSchema.parse(
            await service.grant({
              token,
              idempotencyKey: PlatformUuidSchema.parse(
                request.headers['idempotency-key'],
              ),
              command: ProjectAccessGrantSchema.parse(request.body),
            }),
          ),
        ),
      );
      app.post('/api/platform/v1/access/revocations', (request, reply) =>
        guarded(request, reply, async (token) =>
          ProjectAccessMemberViewSchema.parse(
            await service.revoke({
              token,
              idempotencyKey: PlatformUuidSchema.parse(
                request.headers['idempotency-key'],
              ),
              command: ProjectAccessRevokeSchema.parse(request.body),
            }),
          ),
        ),
      );
    },
  };
}
