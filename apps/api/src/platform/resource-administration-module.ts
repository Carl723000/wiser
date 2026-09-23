import {
  ResourcePolicyRequestsQuerySchema,
  ResourcePolicyRequestsPageSchema,
  ResourcePolicyProposalSchema,
  ResourcePolicyDecisionSchema,
  ResourcePolicyActionSchema,
  ResourcePolicyRevokeSchema,
  ResourcePolicyRequestViewSchema,
  ResourcePolicyRevokeReceiptSchema,
} from '@wiser/platform-contracts';
import {
  ResourceAdministrationError,
  type PostgresResourceAdministrationService,
} from '@wiser/platform-auth';
import {
  ResourceGrantsQuerySchema,
  ResourceGrantsPageSchema,
  ResourceGrantRevokeCommandSchema,
  ResourceGrantRenewCommandSchema,
  ResourceGrantRevokeReceiptSchema,
  ResourceGrantRenewReceiptSchema,
  PlatformUuidSchema,
  ResourceBatchPreviewCommandSchema,
  ResourceBatchDecisionSchema,
  ResourceBatchActionSchema,
  ResourceBatchViewSchema,
  ResourceBatchesQuerySchema,
  ResourceBatchesPageSchema,
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
  | 'sourcePolicyRequests'
  | 'proposeSourcePolicy'
  | 'decideSourcePolicy'
  | 'withdrawSourcePolicy'
  | 'revokeSourcePolicy'
  | 'grants'
  | 'revokeGrant'
  | 'renewGrant'
  | 'definitions'
  | 'savePackage'
  | 'savePreset'
  | 'batches'
  | 'previewBatch'
  | 'decideBatch'
  | 'executeBatch'
  | 'withdrawBatch'
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
  'PREVIEW_EXPIRED',
  'PREVIEW_CHANGED',
  'REQUEST_UNAVAILABLE',
  'REQUEST_STATE_CONFLICT',
  'MEMBERSHIP_CHANGED',
  'AUTHORITY_CHANGED',
  'IMPORTANT_APPROVAL_REQUIRED',
  'SELF_CHANGE_FORBIDDEN',
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
                error.code === 'IDEMPOTENCY_CONFLICT' ||
                error.code === 'PREVIEW_EXPIRED' ||
                error.code === 'PREVIEW_CHANGED' ||
                error.code === 'REQUEST_STATE_CONFLICT' ||
                error.code === 'MEMBERSHIP_CHANGED' ||
                error.code === 'AUTHORITY_CHANGED'
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
        '/api/platform/v1/access/projects/:projectId/source-policy-requests',
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourcePolicyRequestsPageSchema.parse(
              await service.sourcePolicyRequests({
                token,
                projectId: Params.parse(request.params).projectId,
                page: ResourcePolicyRequestsQuerySchema.parse(request.query),
              }),
            ),
          ),
      );
      for (const action of [
        'propose',
        'decide',
        'withdraw',
        'revoke',
      ] as const) {
        app.post(
          '/api/platform/v1/access/source-policies/' + action,
          { bodyLimit: 16384 },
          (request, reply) =>
            guarded(request, reply, async (token) => {
              const shared = {
                token,
                idempotencyKey: PlatformUuidSchema.parse(
                  request.headers['idempotency-key'],
                ),
              };
              if (action === 'revoke')
                return ResourcePolicyRevokeReceiptSchema.parse(
                  await service.revokeSourcePolicy({
                    ...shared,
                    command: ResourcePolicyRevokeSchema.parse(request.body),
                  }),
                );
              const result =
                action === 'propose'
                  ? await service.proposeSourcePolicy({
                      ...shared,
                      command: ResourcePolicyProposalSchema.parse(request.body),
                    })
                  : action === 'decide'
                    ? await service.decideSourcePolicy({
                        ...shared,
                        command: ResourcePolicyDecisionSchema.parse(
                          request.body,
                        ),
                      })
                    : await service.withdrawSourcePolicy({
                        ...shared,
                        command: ResourcePolicyActionSchema.parse(request.body),
                      });
              return ResourcePolicyRequestViewSchema.parse(result);
            }),
        );
      }
      app.get(
        '/api/platform/v1/access/projects/:projectId/resource-grants',
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourceGrantsPageSchema.parse(
              await service.grants({
                token,
                projectId: Params.parse(request.params).projectId,
                page: ResourceGrantsQuerySchema.parse(request.query),
              }),
            ),
          ),
      );
      for (const action of ['revoke', 'renew'] as const)
        app.post(
          '/api/platform/v1/access/resource-grants/' + action,
          { bodyLimit: 16384 },
          (request, reply) =>
            guarded(request, reply, async (token) => {
              const shared = {
                token,
                idempotencyKey: PlatformUuidSchema.parse(
                  request.headers['idempotency-key'],
                ),
              };
              return action === 'revoke'
                ? ResourceGrantRevokeReceiptSchema.parse(
                    await service.revokeGrant({
                      ...shared,
                      command: ResourceGrantRevokeCommandSchema.parse(
                        request.body,
                      ),
                    }),
                  )
                : ResourceGrantRenewReceiptSchema.parse(
                    await service.renewGrant({
                      ...shared,
                      command: ResourceGrantRenewCommandSchema.parse(
                        request.body,
                      ),
                    }),
                  );
            }),
        );
      app.get(
        '/api/platform/v1/access/projects/:projectId/resource-batches',
        (request, reply) =>
          guarded(request, reply, async (token) =>
            ResourceBatchesPageSchema.parse(
              await service.batches({
                token,
                projectId: Params.parse(request.params).projectId,
                page: ResourceBatchesQuerySchema.parse(request.query),
              }),
            ),
          ),
      );
      for (const action of [
        'preview',
        'decide',
        'execute',
        'withdraw',
      ] as const) {
        app.post(
          '/api/platform/v1/access/resource-batches/' + action,
          { bodyLimit: 16384 },
          (request, reply) =>
            guarded(request, reply, async (token) => {
              const idempotencyKey = PlatformUuidSchema.parse(
                request.headers['idempotency-key'],
              );
              const shared = { token, idempotencyKey };
              const result =
                action === 'preview'
                  ? await service.previewBatch({
                      ...shared,
                      command: ResourceBatchPreviewCommandSchema.parse(
                        request.body,
                      ),
                    })
                  : action === 'decide'
                    ? await service.decideBatch({
                        ...shared,
                        command: ResourceBatchDecisionSchema.parse(
                          request.body,
                        ),
                      })
                    : action === 'execute'
                      ? await service.executeBatch({
                          ...shared,
                          command: ResourceBatchActionSchema.parse(
                            request.body,
                          ),
                        })
                      : await service.withdrawBatch({
                          ...shared,
                          command: ResourceBatchActionSchema.parse(
                            request.body,
                          ),
                        });
              return ResourceBatchViewSchema.parse(result);
            }),
        );
      }
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
