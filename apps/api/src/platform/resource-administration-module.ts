import {
  ResourceAdministrationError,
  type PostgresResourceAdministrationService,
} from '@wiser/platform-auth';
import {
  PlatformUuidSchema,
  ResourceDefinitionsQuerySchema,
  ResourceDefinitionsPageSchema,
  ResourceDefinitionReceiptSchema,
  ResourcePackageCommandSchema,
  ResourcePresetCommandSchema,
} from '@wiser/platform-contracts';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WiserApiModule } from './modules.js';
export type ResourceAdministrationHttpService = Pick<
  PostgresResourceAdministrationService,
  'definitions' | 'savePackage' | 'savePreset'
>;
const Params = z.strictObject({ projectId: PlatformUuidSchema });
const publicErrors = new Set([
  'NOT_AUTHENTICATED',
  'NOT_AUTHORIZED',
  'VALIDATION_FAILED',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'RESOURCE_POLICY_NOT_ENABLED',
  'RESOURCE_UNAVAILABLE',
]);
async function guarded(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (token: string) => Promise<unknown>,
) {
  reply.header('Cache-Control', 'private, no-store');
  const token = /^Bearer ([^\s]+)$/.exec(
    request.headers.authorization ?? '',
  )?.[1];
  if (!token) return reply.status(401).send({ code: 'NOT_AUTHENTICATED' });
  try {
    return await work(token);
  } catch (error) {
    if (error instanceof z.ZodError)
      return reply.status(400).send({ code: 'VALIDATION_FAILED' });
    if (
      error instanceof ResourceAdministrationError &&
      publicErrors.has(error.code)
    ) {
      const status =
        error.code === 'NOT_AUTHENTICATED'
          ? 401
          : error.code === 'VALIDATION_FAILED'
            ? 400
            : error.code === 'VERSION_CONFLICT' ||
                error.code === 'IDEMPOTENCY_CONFLICT'
              ? 409
              : 403;
      return reply.status(status).send({ code: error.code });
    }
    return reply.status(503).send({ code: 'ACCESS_UNAVAILABLE' });
  }
}
export function createResourceAdministrationModule(
  service: ResourceAdministrationHttpService,
): WiserApiModule {
  return {
    id: 'platform.resource-administration',
    register(app) {
      app.get(
        '/api/platform/v1/access/projects/:projectId/resource-definitions',
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourceDefinitionsPageSchema.parse(
              await service.definitions({
                token,
                projectId: Params.parse(request.params).projectId,
                page: ResourceDefinitionsQuerySchema.parse(request.query),
              }),
            ),
          ),
      );
      app.post(
        '/api/platform/v1/access/resource-packages',
        { bodyLimit: 262144 },
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourceDefinitionReceiptSchema.parse(
              await service.savePackage({
                token,
                idempotencyKey: PlatformUuidSchema.parse(
                  request.headers['idempotency-key'],
                ),
                command: ResourcePackageCommandSchema.parse(request.body),
              }),
            ),
          ),
      );
      app.post(
        '/api/platform/v1/access/resource-presets',
        { bodyLimit: 16384 },
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourceDefinitionReceiptSchema.parse(
              await service.savePreset({
                token,
                idempotencyKey: PlatformUuidSchema.parse(
                  request.headers['idempotency-key'],
                ),
                command: ResourcePresetCommandSchema.parse(request.body),
              }),
            ),
          ),
      );
    },
  };
}
