import { sameDeliveryAuthority } from './authority-delivery.js';
import { authorizedAssetStream } from './authorized-asset-stream.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  DATA_CAPABILITY_IDS,
  DATA_CAPABILITY_REGISTRY,
  IngestionCandidateReferenceSchema,
  OperationEventPageSchema,
  RelationListInputSchema,
  type DataCapabilityId,
} from '@wiser/data-contracts';
import {
  PlatformRequestContextSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';

import {
  DataCapabilityHandlerError,
  type ExecuteDataCapabilityInput,
} from './capability-handler.js';
import type { WiserApiModule } from '../platform/modules.js';
import { candidateReadAuthority } from './candidate-read-authority.js';
import { CandidateOriginalBudget } from './candidate-original-budget.js';
import {
  CandidateOriginalOutcomeRecorder,
  CandidateOriginalAuditObserver,
  CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS,
  type CandidateOriginalOutcomeError,
} from './candidate-original-outcomes.js';
import {
  MAX_CANDIDATE_ORIGINAL_BYTES,
  type CandidateOriginalPort,
  type CandidateOriginalDownload,
} from './postgres-candidate-original.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSIONED_COMMANDS = new Set<DataCapabilityId>([
  'data.reconciliation.review',
  'data.ingestion.submit',
  'data.ingestion.resume',
  'data.uploadSession.complete',
  'data.ingestion.approve',
  'data.ingestion.reject',
  'data.operation.cancel',
  'data.ingestion.candidate.followup.act',
  'data.ingestion.candidate.followup.review',
]);
const ARRAY_QUERY_FIELDS = new Set([
  'businessDomains',
  'processingStages',
  'securityLevels',
  'qualityGrades',
  'acceptanceStatuses',
  'sources',
  'dataItemIds',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface DataFoundationRequestContextResolver {
  resolve(input: {
    readonly token: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly purpose: string;
    readonly traceId: string;
  }): Promise<PlatformRequestContext | null>;
}

export interface DataFoundationRestCapabilityHandler {
  readonly execute: (input: ExecuteDataCapabilityInput) => Promise<unknown>;
}

export interface DataFoundationAssetDownloadPort extends Partial<CandidateOriginalPort> {
  createDownload(input: {
    readonly context: PlatformRequestContext;
    readonly internal?: boolean;
    readonly versionId: string;
    readonly assetId?: string;
  }): Promise<{ readonly url: string; readonly expiresAt: string }>;
}

export interface DataFoundationRestModuleOptions {
  readonly resolver: DataFoundationRequestContextResolver;
  readonly handler: DataFoundationRestCapabilityHandler;
  readonly assetDownload?: DataFoundationAssetDownloadPort;
  readonly assetContentFetch?: typeof globalThis.fetch;
}

interface ErrorMapping {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function singleHeader(value: string | readonly string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function bearerToken(value: string | undefined): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null;
}

function setNoStore(reply: FastifyReply): void {
  reply.header(
    'Cache-Control',
    'private, no-cache, no-store, max-age=0, must-revalidate',
  );
  reply.header('Expires', '0');
  reply.header('Pragma', 'no-cache');
}

function traceId(request: FastifyRequest): string {
  const candidate = request.id.replaceAll('-', '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(candidate)
    ? candidate
    : createHash('sha256').update(request.id).digest('hex').slice(0, 32);
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  mapping: ErrorMapping,
) {
  setNoStore(reply);
  return reply.status(mapping.status).send({
    code: mapping.code,
    message: mapping.message,
    traceId: traceId(request),
  });
}

const errors = {
  unauthenticated: {
    status: 401,
    code: 'NOT_AUTHENTICATED',
    message:
      '需要 Bearer credential、Tenant、Project 与 Purpose。 / Bearer credential, Tenant, Project, and Purpose are required.',
  },
  unauthorized: {
    status: 403,
    code: 'NOT_AUTHORIZED',
    message:
      '当前身份无权访问该数据项目上下文。 / The current identity is not authorized for this data project context.',
  },
  validation: {
    status: 422,
    code: 'VALIDATION_FAILED',
    message:
      '数据能力请求未通过校验。 / The Data Capability request failed validation.',
  },
  idempotency: {
    status: 422,
    code: 'IDEMPOTENCY_KEY_REQUIRED',
    message:
      '写操作需要 UUID Idempotency-Key。 / Commands require a UUID Idempotency-Key.',
  },
  forbidden: {
    status: 403,
    code: 'FORBIDDEN',
    message:
      '当前身份无权执行该数据能力。 / The current identity cannot execute this Data Capability.',
  },
  conflict: {
    status: 409,
    code: 'CONFLICT',
    message:
      '资源状态或版本已发生变化。 / The resource state or version has changed.',
  },
  notFound: {
    status: 404,
    code: 'NOT_FOUND',
    message:
      '请求的数据资源不存在。 / The requested data resource was not found.',
  },
  unavailable: {
    status: 503,
    code: 'CAPABILITY_UNAVAILABLE',
    message:
      '数据能力暂时不可用。 / The Data Capability is temporarily unavailable.',
  },
  internal: {
    status: 500,
    code: 'INTERNAL_ERROR',
    message:
      '服务暂时无法完成请求。 / The service could not complete the request.',
  },
} as const satisfies Readonly<Record<string, ErrorMapping>>;

function ownErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string' ? descriptor.value : null;
}

function mapError(error: unknown): ErrorMapping {
  if (error instanceof DataCapabilityHandlerError) {
    switch (error.code) {
      case 'NOT_AUTHENTICATED':
        return errors.unauthenticated;
      case 'FORBIDDEN':
      case 'SECURITY_LEVEL_EXCEEDED':
        return errors.forbidden;
      case 'NOT_FOUND':
        return errors.notFound;
      case 'CONFLICT':
        return errors.conflict;
      case 'VALIDATION_FAILED':
        return errors.validation;
      case 'IDEMPOTENCY_KEY_REQUIRED':
        return errors.idempotency;
      case 'EXTERNAL_SOURCE_UNCONFIGURED':
      case 'EXTERNAL_SOURCE_UNAVAILABLE':
        return { status: 503, code: error.code, message: error.message };
      case 'EXTERNAL_SOURCE_TIMEOUT':
        return { status: 504, code: error.code, message: error.message };
      case 'EXTERNAL_SOURCE_ACCESS_DENIED':
      case 'EXTERNAL_AUTHORIZATION_EXPIRED':
        return { status: 403, code: error.code, message: error.message };
      case 'EXTERNAL_METADATA_INVALID':
        return { status: 502, code: error.code, message: error.message };
      case 'REQUEST_CANCELLED':
        return { status: 499, code: error.code, message: error.message };
      case 'CAPABILITY_TIMEOUT':
      case 'EXECUTION_FAILED':
        return errors.unavailable;
      case 'INVALID_CONFIGURATION':
      case 'IMPLEMENTATION_CONTRACT_VIOLATION':
      case 'AUDIT_FAILED':
        return errors.internal;
    }
  }
  const code = ownErrorCode(error);
  if (
    code === 'CONFLICT' ||
    code === 'VERSION_CONFLICT' ||
    code === 'STATE_CONFLICT' ||
    code === 'IDEMPOTENCY_CONFLICT' ||
    code?.endsWith('_VERSION_CONFLICT') === true ||
    code?.endsWith('_STATE_CONFLICT') === true
  ) {
    return errors.conflict;
  }
  if (code === 'NOT_FOUND' || code?.endsWith('_NOT_FOUND') === true) {
    return errors.notFound;
  }
  if (code === 'FORBIDDEN' || code === 'NOT_AUTHORIZED') {
    return errors.forbidden;
  }
  if (code === 'UNAVAILABLE') return errors.unavailable;
  if (code === 'VALIDATION_FAILED') return errors.validation;
  return errors.internal;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

type CapabilityRuntimeSchema =
  (typeof DATA_CAPABILITY_REGISTRY)[DataCapabilityId]['inputSchema'];

function jsonSchema(
  schema: CapabilityRuntimeSchema,
): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema, { target: 'draft-7' });
}

function pathParameterNames(path: string): readonly string[] {
  return Object.freeze(
    [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!),
  );
}

function projectObjectSchema(
  source: Readonly<Record<string, unknown>>,
  selectedNames: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (selectedNames.length === 0) return null;
  const sourceProperties = record(source['properties']);
  if (sourceProperties === null) return null;
  const properties: Record<string, unknown> = {};
  for (const name of selectedNames) {
    const property = sourceProperties[name];
    if (property === undefined) return null;
    properties[name] = property;
  }
  const sourceRequired = Array.isArray(source['required'])
    ? source['required'].filter(
        (name): name is string =>
          typeof name === 'string' && selectedNames.includes(name),
      )
    : [];
  return {
    ...source,
    properties,
    ...(sourceRequired.length === 0
      ? { required: undefined }
      : { required: sourceRequired }),
    additionalProperties: false,
  };
}

function requestHeadersSchema(
  capabilityId: DataCapabilityId,
  kind: 'query' | 'command',
): Readonly<Record<string, unknown>> {
  const required = [
    'x-wiser-tenant-id',
    'x-wiser-project-id',
    'x-wiser-purpose',
    ...(kind === 'command' ? ['idempotency-key'] : []),
    ...(VERSIONED_COMMANDS.has(capabilityId) ? ['if-match'] : []),
  ];
  return {
    type: 'object',
    required,
    properties: {
      'x-wiser-tenant-id': { type: 'string', format: 'uuid' },
      'x-wiser-project-id': { type: 'string', format: 'uuid' },
      'x-wiser-purpose': {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      ...(kind === 'command'
        ? { 'idempotency-key': { type: 'string', format: 'uuid' } }
        : {}),
      ...(VERSIONED_COMMANDS.has(capabilityId)
        ? { 'if-match': { type: 'string', pattern: '^"v[1-9]\\d*"$' } }
        : {}),
    },
    additionalProperties: true,
  };
}

function capabilityRouteSchema(capabilityId: DataCapabilityId) {
  const definition = DATA_CAPABILITY_REGISTRY[capabilityId];
  const input = jsonSchema(definition.inputSchema);
  const unionKey = Array.isArray(input['oneOf'])
    ? 'oneOf'
    : Array.isArray(input['anyOf'])
      ? 'anyOf'
      : null;
  const branches =
    unionKey === null ? [input] : (input[unionKey] as unknown[]).map(record);
  if (
    branches.some(
      (branch) => branch === null || record(branch['properties']) === null,
    )
  )
    throw new Error(
      `Capability ${capabilityId} requires strict object input branches.`,
    );
  const objects = branches as Readonly<Record<string, unknown>>[];
  const pathNames = pathParameterNames(definition.restMapping.path);
  const projectedParams = objects.map((branch) =>
    projectObjectSchema(branch, pathNames),
  );
  if (
    projectedParams.some(
      (params) => JSON.stringify(params) !== JSON.stringify(projectedParams[0]),
    )
  )
    throw new Error(
      `Capability ${capabilityId} requires identical path parameters in every branch.`,
    );
  const params = projectedParams[0] ?? null;
  const transportBranches = objects.map((branch) =>
    projectObjectSchema(
      branch,
      Object.keys(record(branch['properties'])!).filter(
        (name) => !pathNames.includes(name),
      ),
    ),
  );
  const transport =
    unionKey === null
      ? transportBranches[0]
      : { [unionKey]: transportBranches };
  const response =
    definition.restMapping.responseMode === 'SSE'
      ? { type: 'string', contentMediaType: 'text/event-stream' }
      : jsonSchema(definition.outputSchema);
  return {
    tags: ['data-foundation'],
    summary: capabilityId,
    description: `WISER Data Capability ${capabilityId} v${definition.version}`,
    operationId: capabilityId.replaceAll('.', '_'),
    security: [{ bearerAuth: [] }],
    headers: requestHeadersSchema(capabilityId, definition.kind),
    ...(params === null ? {} : { params }),
    ...(transport === null
      ? {}
      : definition.restMapping.method === 'GET'
        ? { querystring: transport }
        : { body: transport }),
    response: {
      [definition.restMapping.successStatus]: response,
    },
  };
}

const passThroughValidatorCompiler = () => (value: unknown) => ({ value });
const passThroughSerializerCompiler = () => (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value);

function normalizeQuery(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  const source = record(value);
  if (source === null) return null;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) return null;
    if (key === 'relatedSources' || key === 'entityReference') {
      if (typeof entry !== 'string' || entry.length > 8192) return null;
      try {
        const parsed = RelationListInputSchema.shape[key].safeParse(
          JSON.parse(entry),
        );
        if (!parsed.success) return null;
        normalized[key] = parsed.data;
      } catch {
        return null;
      }
      continue;
    }
    if (key === 'includeTotal' || key === 'latestPerAsset') {
      if (entry !== 'true' && entry !== 'false') return null;
      normalized[key] = entry === 'true';
      continue;
    }
    if (key === 'groupIndex') {
      if (typeof entry !== 'string' || !/^(?:0|[1-9]\d{0,4})$/.test(entry))
        return null;
      normalized[key] = Number(entry);
      continue;
    }
    if (key === 'first') {
      if (typeof entry !== 'string' || !/^[1-9]\d{0,2}$/.test(entry)) {
        return null;
      }
      normalized[key] = Number(entry);
      continue;
    }
    if (ARRAY_QUERY_FIELDS.has(key)) {
      const values = queryStringArray(entry);
      if (
        values === null ||
        values.length > 256 ||
        !values.every((item) => typeof item === 'string' && item.length > 0)
      ) {
        return null;
      }
      normalized[key] = [...values];
      continue;
    }
    if (typeof entry !== 'string') return null;
    normalized[key] = entry;
  }
  return normalized;
}

function composeInput(request: FastifyRequest): Record<string, unknown> | null {
  const parts: readonly (Readonly<Record<string, unknown>> | null)[] = [
    record(request.params ?? {}),
    normalizeQuery(request.query ?? {}),
    request.body === undefined ? {} : record(request.body),
  ];
  if (parts.some((part) => part === null)) return null;
  const result: Record<string, unknown> = {};
  for (const part of parts) {
    if (part === null) continue;
    for (const [key, value] of Object.entries(part)) {
      if (FORBIDDEN_KEYS.has(key) || Object.hasOwn(result, key)) return null;
      result[key] = value;
    }
  }
  return result;
}

function queryStringArray(value: unknown): readonly string[] | null {
  if (typeof value === 'string') return value.split(',');
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') return null;
    result.push(entry);
  }
  return result;
}

function parseIfMatch(value: string | undefined): number | null {
  const match = /^"v([1-9]\d*)"$/.exec(value ?? '');
  if (match?.[1] === undefined) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function enforceIfMatch(
  capabilityId: DataCapabilityId,
  input: Record<string, unknown>,
  header: string | undefined,
): boolean {
  if (!VERSIONED_COMMANDS.has(capabilityId)) return true;
  const version = parseIfMatch(header);
  if (version === null) return false;
  if (input['expectedVersion'] === undefined) {
    input['expectedVersion'] = version;
    return true;
  }
  return input['expectedVersion'] === version;
}

function responseVersion(value: unknown, depth = 0): number | null {
  if (depth > 3) return null;
  const candidate = record(value);
  if (candidate === null) return null;
  const direct = candidate['version'];
  if (
    typeof direct === 'number' &&
    Number.isSafeInteger(direct) &&
    direct > 0
  ) {
    return direct;
  }
  for (const key of [
    'item',
    'selectedVersion',
    'ingestion',
    'uploadSession',
    'operation',
  ]) {
    const nested = responseVersion(candidate[key], depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function sseSnapshot(output: unknown): {
  readonly body: string;
  readonly nextCursor?: string;
} | null {
  const parsed = OperationEventPageSchema.safeParse(output);
  if (!parsed.success) return null;
  const body = parsed.data.items
    .map(
      (event) =>
        `id: ${event.eventId}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return {
    body: body.length === 0 ? ': snapshot\n\n' : body,
    ...(parsed.data.nextCursor === undefined
      ? {}
      : { nextCursor: parsed.data.nextCursor }),
  };
}

async function resolveContext(
  request: FastifyRequest,
  resolver: DataFoundationRequestContextResolver,
): Promise<
  | { readonly context: PlatformRequestContext }
  | { readonly error: ErrorMapping }
> {
  const token = bearerToken(singleHeader(request.headers.authorization));
  const tenantId = singleHeader(request.headers['x-wiser-tenant-id']);
  const projectId = singleHeader(request.headers['x-wiser-project-id']);
  const purpose = singleHeader(request.headers['x-wiser-purpose']);
  if (
    token === null ||
    tenantId === undefined ||
    projectId === undefined ||
    purpose === undefined
  ) {
    return { error: errors.unauthenticated };
  }
  let rawContext: PlatformRequestContext | null;
  try {
    rawContext = await resolver.resolve({
      token,
      tenantId,
      projectId,
      purpose,
      traceId: traceId(request),
    });
  } catch {
    return { error: errors.unavailable };
  }
  const parsed = PlatformRequestContextSchema.safeParse(rawContext);
  if (
    !parsed.success ||
    parsed.data.authorization.tenantId !== tenantId ||
    parsed.data.authorization.projectId !== projectId ||
    parsed.data.authorization.purpose !== purpose
  ) {
    return { error: errors.unauthorized };
  }
  return { context: parsed.data };
}

export function createDataFoundationRestModule(
  options: DataFoundationRestModuleOptions,
): WiserApiModule {
  if (
    options.resolver === null ||
    typeof options.resolver?.resolve !== 'function' ||
    options.handler === null ||
    typeof options.handler?.execute !== 'function'
  ) {
    throw new Error('Invalid Data Foundation REST module configuration.');
  }
  return {
    id: 'data.foundation.rest',
    register(app) {
      const candidateOriginalBudget = new CandidateOriginalBudget();
      const originalAudits = new CandidateOriginalAuditObserver(
        (code, attemptId) => {
          app.log.error(
            { code, attemptId },
            'Candidate original output audit was not confirmed.',
          );
        },
      );
      app.addHook('onClose', (_instance, done) => {
        originalAudits.close();
        done();
      });
      for (const capabilityId of DATA_CAPABILITY_IDS) {
        const definition = DATA_CAPABILITY_REGISTRY[capabilityId];
        app.route({
          method: definition.restMapping.method,
          url: definition.restMapping.path,
          schema: capabilityRouteSchema(capabilityId),
          validatorCompiler: passThroughValidatorCompiler,
          serializerCompiler: passThroughSerializerCompiler,
          handler: async (request, reply) => {
            setNoStore(reply);
            const resolved = await resolveContext(request, options.resolver);
            if ('error' in resolved) {
              return sendError(request, reply, resolved.error);
            }
            const input = composeInput(request);
            if (input === null) {
              return sendError(request, reply, errors.validation);
            }
            const idempotencyKey = singleHeader(
              request.headers['idempotency-key'],
            );
            if (definition.kind === 'command') {
              if (idempotencyKey === undefined) {
                return sendError(request, reply, errors.idempotency);
              }
              if (!UUID_PATTERN.test(idempotencyKey)) {
                return sendError(request, reply, errors.validation);
              }
            }
            if (
              !enforceIfMatch(
                capabilityId,
                input,
                singleHeader(request.headers['if-match']),
              )
            ) {
              return sendError(request, reply, errors.validation);
            }

            const cancellation =
              capabilityId === 'data.external.metadata.read'
                ? new AbortController()
                : undefined;
            const disconnected = () => {
              if (!reply.raw.writableFinished) cancellation?.abort();
            };
            if (cancellation) {
              reply.raw.once('close', disconnected);
              if (request.raw.aborted || reply.raw.destroyed)
                cancellation.abort();
            }
            let output: unknown;
            try {
              output = await options.handler.execute({
                capabilityId,
                input,
                requestContext: resolved.context,
                ...(cancellation ? { signal: cancellation.signal } : {}),
                ...(definition.kind === 'command' &&
                idempotencyKey !== undefined
                  ? { idempotencyKey }
                  : {}),
              });
            } catch (error) {
              return sendError(request, reply, mapError(error));
            } finally {
              if (cancellation) reply.raw.removeListener('close', disconnected);
            }

            const fresh = await resolveContext(request, options.resolver);
            if ('error' in fresh) return sendError(request, reply, fresh.error);
            if (!sameDeliveryAuthority(resolved.context, fresh.context))
              return sendError(request, reply, errors.forbidden);
            if (definition.restMapping.responseMode === 'SSE') {
              const snapshot = sseSnapshot(output);
              if (snapshot === null) {
                return sendError(request, reply, errors.internal);
              }
              reply.header('Content-Type', 'text/event-stream; charset=utf-8');
              reply.header('Connection', 'keep-alive');
              reply.header('X-Accel-Buffering', 'no');
              if (snapshot.nextCursor !== undefined) {
                reply.header('X-Next-Cursor', snapshot.nextCursor);
              }
              return reply
                .status(definition.restMapping.successStatus)
                .send(snapshot.body);
            }

            const version = responseVersion(output);
            if (version !== null) reply.header('ETag', `"v${version}"`);
            return reply
              .status(definition.restMapping.successStatus)
              .send(output);
          },
        });
      }
      if (options.assetDownload !== undefined) {
        app.route({
          method: ['GET', 'HEAD'],
          url: '/api/data/v1/tenants/:tenantId/projects/:projectId/ingestions/:ingestionId/candidates/:processingBatchId/assets/:assetId/content',
          handler: async (request, reply) => {
            setNoStore(reply);
            const params = record(request.params);
            const query = record(request.query);
            const assetId = params?.['assetId'];
            const reference = IngestionCandidateReferenceSchema.safeParse({
              kind: 'ingestion-candidate',
              ingestionId: params?.['ingestionId'],
              processingBatchId: params?.['processingBatchId'],
              reviewHash: query?.['reviewHash'],
            });
            const tenantId = params?.['tenantId'];
            const projectId = params?.['projectId'];
            const range = request.headers.range;
            if (
              !reference.success ||
              !query ||
              Object.keys(query).length !== 1 ||
              typeof tenantId !== 'string' ||
              !UUID_PATTERN.test(tenantId) ||
              typeof projectId !== 'string' ||
              !UUID_PATTERN.test(projectId) ||
              typeof assetId !== 'string' ||
              !UUID_PATTERN.test(assetId) ||
              (range !== undefined &&
                !/^bytes=(?:[0-9]{1,15}-[0-9]{0,15}|-[0-9]{1,15})$/.test(range))
            )
              return sendError(request, reply, errors.validation);
            const resolved = await resolveContext(request, options.resolver);
            if ('error' in resolved)
              return sendError(request, reply, resolved.error);
            const authority = candidateReadAuthority(resolved.context);
            if (
              (!authority.maintainer && !authority.reviewer) ||
              resolved.context.authorization.tenantId !== tenantId ||
              resolved.context.authorization.projectId !== projectId
            )
              return sendError(request, reply, errors.forbidden);
            const port = options.assetDownload!;
            if (
              !port.createCandidateDownload ||
              !port.authorizeCandidateDownload ||
              !port.appendCandidateOriginalOutcome
            )
              return sendError(request, reply, errors.unavailable);
            const input = {
              context: resolved.context,
              reference: reference.data,
              assetId,
            };
            const authorize = async () => {
              const fresh = await resolveContext(request, options.resolver);
              if ('error' in fresh)
                throw Object.assign(new Error('Original access unavailable'), {
                  code:
                    fresh.error.status === 503 ? 'UNAVAILABLE' : 'FORBIDDEN',
                });
              if (!sameDeliveryAuthority(resolved.context, fresh.context))
                throw Object.assign(new Error('Original access unavailable'), {
                  code: 'FORBIDDEN',
                });
              await port.authorizeCandidateDownload!({
                ...input,
                context: fresh.context,
              });
            };
            const controller = new AbortController();
            let releaseBudget: (() => void) | undefined;
            let deliveryStream: Readable | undefined;
            let streaming = false;
            let outcomes: CandidateOriginalOutcomeRecorder | undefined;
            let deliveryFailure: CandidateOriginalOutcomeError =
              'CLIENT_CLOSED';
            const observeOriginalAudit = (task: Promise<void>) =>
              originalAudits.observe(task, outcomes!.attemptId);
            reply.raw.once('finish', () => {
              if (outcomes) void observeOriginalAudit(outcomes.finish());
            });
            const close = () => {
              if (outcomes)
                void observeOriginalAudit(outcomes.interrupt(deliveryFailure));
              controller.abort();
              deliveryStream?.destroy();
              if (streaming) releaseBudget?.();
            };
            reply.raw.once('close', close);
            try {
              const download = await port.createCandidateDownload(input);
              // The opaque receipt is internal; signed storage URLs never enter outcome metadata.
              if (
                !download.outcomeReceipt ||
                typeof download.outcomeReceipt !== 'object'
              )
                return sendError(request, reply, errors.unavailable);
              if (
                Number.isSafeInteger(download.sizeBytes) &&
                download.sizeBytes >= 1 &&
                download.sizeBytes <= MAX_CANDIDATE_ORIGINAL_BYTES
              )
                outcomes = new CandidateOriginalOutcomeRecorder(
                  request.method as 'GET' | 'HEAD',
                  range !== undefined,
                  download.sizeBytes,
                  (outcome) =>
                    port.appendCandidateOriginalOutcome!(
                      download.outcomeReceipt,
                      outcome,
                    ),
                );
              if (controller.signal.aborted) {
                if (outcomes) void observeOriginalAudit(outcomes.interrupt());
                return sendError(request, reply, errors.unavailable);
              }
              const url = new URL(download.url);
              if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                !Number.isSafeInteger(download.sizeBytes) ||
                download.sizeBytes < 1 ||
                download.sizeBytes > MAX_CANDIDATE_ORIGINAL_BYTES ||
                !Number.isFinite(Date.parse(download.expiresAt)) ||
                Date.parse(download.expiresAt) <= Date.now()
              )
                return sendError(request, reply, errors.unavailable);
              await authorize();
              if (controller.signal.aborted)
                return sendError(request, reply, errors.unavailable);
              releaseBudget =
                candidateOriginalBudget.tryReserve({
                  tenantId,
                  projectId,
                  responsibleActorId:
                    resolved.context.principal.delegatedBy ??
                    resolved.context.principal.actorId,
                  sizeBytes: download.sizeBytes,
                }) ?? undefined;
              if (!releaseBudget) {
                if (outcomes)
                  void observeOriginalAudit(
                    outcomes.fail('CAPACITY_REJECTED', 'CAPACITY_LIMIT'),
                  );
                reply.header('Retry-After', '1');
                return sendError(request, reply, errors.unavailable);
              }
              const upstream = await (
                options.assetContentFetch ?? globalThis.fetch
              )(download.url, {
                method: 'GET',
                redirect: 'error',
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(CANDIDATE_ORIGINAL_OPERATION_TIMEOUT_MS),
                ]),
              });
              if (controller.signal.aborted) {
                await upstream.body?.cancel();
                return sendError(request, reply, errors.unavailable);
              }
              if (upstream.status !== 200 || !upstream.body) {
                await upstream.body?.cancel();
                return sendError(request, reply, errors.unavailable);
              }
              // Quarantine keys are not published immutable objects. Verify the
              // complete bounded original before releasing any byte, even ranges.
              const bytes = await verifyCandidateOriginal(
                upstream.body,
                download,
              );
              if (controller.signal.aborted)
                return sendError(request, reply, errors.unavailable);
              await authorize();
              const type =
                upstream.headers.get('content-type') ??
                'application/octet-stream';
              if (type.length > 256 || /[\r\n]/.test(type))
                return sendError(request, reply, errors.unavailable);
              const selected = candidateOriginalRange(range, bytes.length);
              reply
                .header('X-Content-Type-Options', 'nosniff')
                .header(
                  'Content-Security-Policy',
                  "default-src 'none'; sandbox; frame-ancestors 'self'",
                )
                .header('Content-Disposition', 'attachment')
                .header('Content-Type', type)
                .header('Accept-Ranges', 'bytes');
              if (!selected) {
                if (outcomes)
                  void observeOriginalAudit(
                    outcomes.fail('OUTPUT_FAILED', 'RANGE_UNSATISFIABLE'),
                  );
                reply
                  .status(416)
                  .header('Content-Range', `bytes */${bytes.length}`);
                return reply.send();
              }
              const { start, end } = selected;
              outcomes?.select(start, end);
              reply
                .status(range === undefined ? 200 : 206)
                .header('Content-Length', String(end - start + 1));
              if (range !== undefined)
                reply.header(
                  'Content-Range',
                  `bytes ${start}-${end}/${bytes.length}`,
                );
              if (request.method === 'HEAD') return reply.send();
              const selectedBytes = bytes.subarray(start, end + 1);
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  for (
                    let offset = 0;
                    offset < selectedBytes.length;
                    offset += 65536
                  )
                    controller.enqueue(
                      selectedBytes.subarray(offset, offset + 65536),
                    );
                  controller.close();
                },
              });
              const authorized = authorizedAssetStream(stream, async () => {
                try {
                  await authorize();
                  return true;
                } catch (error) {
                  const code = mapError(error).code;
                  deliveryFailure =
                    code === 'FORBIDDEN' || code === 'NOT_FOUND'
                      ? 'AUTHORITY_CHANGED'
                      : 'UNAVAILABLE';
                  return false;
                }
              });
              async function* measured() {
                for await (const chunk of authorized) {
                  outcomes?.offer(chunk.byteLength);
                  yield chunk;
                }
              }
              deliveryStream = Readable.from(measured(), { objectMode: false });
              deliveryStream.once('error', () => {
                if (outcomes)
                  void observeOriginalAudit(
                    outcomes.interrupt(deliveryFailure),
                  );
              });
              streaming = true;
              try {
                return reply.send(deliveryStream);
              } catch (error) {
                streaming = false;
                throw error;
              }
            } catch (error) {
              const integrityCode =
                error instanceof Error && 'originalIntegrityCode' in error
                  ? error.originalIntegrityCode
                  : undefined;
              if (outcomes) {
                if (
                  integrityCode === 'HASH_MISMATCH' ||
                  integrityCode === 'SIZE_MISMATCH'
                )
                  void observeOriginalAudit(
                    outcomes.fail('INTEGRITY_FAILED', integrityCode),
                  );
                else if (controller.signal.aborted)
                  void observeOriginalAudit(
                    outcomes.interrupt(deliveryFailure),
                  );
                else
                  void observeOriginalAudit(
                    outcomes.fail(
                      'OUTPUT_FAILED',
                      mapError(error).code === 'FORBIDDEN' ||
                        mapError(error).code === 'NOT_FOUND'
                        ? 'AUTHORITY_CHANGED'
                        : 'UNAVAILABLE',
                    ),
                  );
              }
              return sendError(request, reply, mapError(error));
            } finally {
              if (!streaming) releaseBudget?.();
            }
          },
        });
        for (const delivery of ['redirect', 'content'] as const)
          app.route({
            method: delivery === 'content' ? ['GET', 'HEAD'] : 'GET',
            url:
              '/api/data/v1/tenants/:tenantId/projects/:projectId/versions/:versionId/assets/:assetId' +
              (delivery === 'content' ? '/content' : ''),
            handler: async (request, reply) => {
              setNoStore(reply);
              const params = record(request.params);
              const tenantId = params?.['tenantId'];
              const projectId = params?.['projectId'];
              const versionId = params?.['versionId'];
              const assetId = params?.['assetId'];
              if (
                typeof tenantId !== 'string' ||
                !UUID_PATTERN.test(tenantId) ||
                typeof projectId !== 'string' ||
                !UUID_PATTERN.test(projectId) ||
                typeof versionId !== 'string' ||
                !UUID_PATTERN.test(versionId) ||
                typeof assetId !== 'string' ||
                (assetId !== 'source' && !UUID_PATTERN.test(assetId))
              ) {
                return sendError(request, reply, errors.validation);
              }
              const resolved = await resolveContext(request, options.resolver);
              if ('error' in resolved) {
                return sendError(request, reply, resolved.error);
              }
              if (
                resolved.context.authorization.tenantId !== tenantId ||
                resolved.context.authorization.projectId !== projectId ||
                !resolved.context.authorization.scopes.includes(
                  'data.catalog.read',
                )
              ) {
                return sendError(request, reply, errors.forbidden);
              }
              const proxyDelivery =
                delivery === 'content' ||
                resolved.context.authorization.resourceAccess !== undefined;
              const range = request.headers.range;
              if (
                proxyDelivery &&
                (Object.keys(record(request.query) ?? {}).length > 0 ||
                  (range !== undefined &&
                    !/^bytes=(?:[0-9]{1,15}-[0-9]{0,15}|-[0-9]{1,15})$/.test(
                      range,
                    )))
              )
                return sendError(request, reply, errors.validation);
              let download: {
                readonly url: string;
                readonly expiresAt: string;
              };
              try {
                download = await options.assetDownload!.createDownload({
                  context: resolved.context,
                  versionId,
                  ...(assetId === 'source' ? {} : { assetId }),
                  ...(proxyDelivery ? { internal: true } : {}),
                });
                const url = new URL(download.url);
                if (
                  !['http:', 'https:'].includes(url.protocol) ||
                  url.username.length > 0 ||
                  url.password.length > 0 ||
                  !Number.isFinite(Date.parse(download.expiresAt))
                ) {
                  throw new Error('invalid download contract');
                }
              } catch (error) {
                return sendError(request, reply, mapError(error));
              }
              const fresh = await resolveContext(request, options.resolver);
              if ('error' in fresh)
                return sendError(request, reply, fresh.error);
              if (!sameDeliveryAuthority(resolved.context, fresh.context))
                return sendError(request, reply, errors.forbidden);
              if (proxyDelivery) {
                const controller = new AbortController();
                const close = () => controller.abort();
                reply.raw.once('close', close);
                try {
                  // The internal URL signs GetObject. A HEAD against that URL
                  // has a different SigV4 method and is rejected by storage.
                  const metadataProbe =
                    request.method === 'HEAD' && range === undefined;
                  const fetchContent =
                    options.assetContentFetch ?? globalThis.fetch;
                  const upstreamSignal = AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(120000),
                  ]);
                  let upstream = await fetchContent(download.url, {
                    method: 'GET',
                    headers:
                      range === undefined
                        ? metadataProbe
                          ? { range: 'bytes=0-0' }
                          : {}
                        : { range },
                    redirect: 'error',
                    signal: upstreamSignal,
                  });
                  if (
                    metadataProbe &&
                    upstream.status === 416 &&
                    upstream.headers.get('content-range') === 'bytes */0'
                  ) {
                    await upstream.body?.cancel();
                    // Empty objects have no first byte. Retrieve their real
                    // content type without transferring an object body.
                    upstream = await fetchContent(download.url, {
                      method: 'GET',
                      redirect: 'error',
                      signal: upstreamSignal,
                    });
                    if (
                      upstream.status !== 200 ||
                      upstream.headers.get('content-length') !== '0'
                    ) {
                      await upstream.body?.cancel();
                      return sendError(request, reply, errors.unavailable);
                    }
                  }
                  if (![200, 206, 416].includes(upstream.status)) {
                    await upstream.body?.cancel();
                    return sendError(request, reply, errors.unavailable);
                  }
                  const probeRange = metadataProbe && upstream.status === 206;
                  const probeLength = probeRange
                    ? /^bytes 0-0\/([1-9][0-9]{0,14})$/.exec(
                        upstream.headers.get('content-range') ?? '',
                      )?.[1]
                    : undefined;
                  if (
                    (probeRange && probeLength === undefined) ||
                    (metadataProbe && upstream.status === 416)
                  ) {
                    await upstream.body?.cancel();
                    return sendError(request, reply, errors.unavailable);
                  }
                  const beforeBytes = await resolveContext(
                    request,
                    options.resolver,
                  );
                  if (
                    'error' in beforeBytes ||
                    !sameDeliveryAuthority(
                      resolved.context,
                      beforeBytes.context,
                    )
                  ) {
                    await upstream.body?.cancel();
                    return sendError(
                      request,
                      reply,
                      'error' in beforeBytes
                        ? beforeBytes.error
                        : errors.forbidden,
                    );
                  }
                  const type =
                    upstream.headers.get('content-type') ??
                    'application/octet-stream';
                  if (type.length > 256 || /[\r\n]/.test(type)) {
                    await upstream.body?.cancel();
                    return sendError(request, reply, errors.unavailable);
                  }
                  reply
                    .status(probeRange ? 200 : upstream.status)
                    .header('Content-Type', type)
                    .header('X-Content-Type-Options', 'nosniff')
                    .header(
                      'Content-Security-Policy',
                      "default-src 'none'; sandbox; frame-ancestors 'self'",
                    )
                    .header('Content-Disposition', 'attachment');
                  for (const header of [
                    'content-length',
                    'content-range',
                    'accept-ranges',
                  ]) {
                    if (probeRange && header === 'content-range') continue;
                    const value = upstream.headers.get(header);
                    const represented =
                      probeRange && header === 'content-length'
                        ? probeLength
                        : value;
                    if (
                      represented !== null &&
                      represented !== undefined &&
                      represented.length < 128 &&
                      !/[\r\n]/.test(represented)
                    )
                      reply.header(header, represented);
                  }
                  if (request.method === 'HEAD' || upstream.status === 416) {
                    await upstream.body?.cancel();
                    return reply.send();
                  }
                  if (!upstream.body)
                    return sendError(request, reply, errors.unavailable);
                  return reply.send(
                    Readable.from(
                      authorizedAssetStream(upstream.body, async () => {
                        const current = await resolveContext(
                          request,
                          options.resolver,
                        );
                        return (
                          !('error' in current) &&
                          sameDeliveryAuthority(
                            resolved.context,
                            current.context,
                          )
                        );
                      }),
                      { objectMode: false },
                    ),
                  );
                } catch {
                  return sendError(request, reply, errors.unavailable);
                }
              }
              reply.header('Location', download.url);
              reply.header('X-Signed-Url-Expires-At', download.expiresAt);
              return reply.status(303).send();
            },
          });
      }
    },
  };
}

async function verifyCandidateOriginal(
  body: ReadableStream<Uint8Array>,
  expected: CandidateOriginalDownload,
): Promise<Buffer> {
  const unavailable = (
    originalIntegrityCode?: 'SIZE_MISMATCH' | 'HASH_MISMATCH',
  ) =>
    Object.assign(new Error('Original verification unavailable'), {
      code: 'UNAVAILABLE',
      ...(originalIntegrityCode ? { originalIntegrityCode } : {}),
    });
  const reader = body.getReader();
  let complete = false;
  try {
    if (
      !Number.isSafeInteger(expected.sizeBytes) ||
      expected.sizeBytes < 1 ||
      expected.sizeBytes > MAX_CANDIDATE_ORIGINAL_BYTES ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw unavailable();
    const bytes = Buffer.alloc(expected.sizeBytes);
    const hash = createHash('sha256');
    let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      const end = length + next.value.byteLength;
      if (end > expected.sizeBytes) throw unavailable('SIZE_MISMATCH');
      bytes.set(next.value, length);
      hash.update(bytes.subarray(length, end));
      length = end;
    }
    if (length !== expected.sizeBytes) throw unavailable('SIZE_MISMATCH');
    if (hash.digest('hex') !== expected.sha256)
      throw unavailable('HASH_MISMATCH');
    return bytes;
  } catch (error) {
    if (error instanceof Error && 'originalIntegrityCode' in error) throw error;
    throw unavailable();
  } finally {
    try {
      if (!complete) await reader.cancel();
    } catch {
      /* Preserve the sanitized error. */
    }
    reader.releaseLock();
  }
}

function candidateOriginalRange(range: string | undefined, length: number) {
  if (range === undefined) return { start: 0, end: length - 1 };
  const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!parts) return null;
  if (!parts[1]) {
    const suffix = Number(parts[2]);
    return suffix > 0
      ? { start: Math.max(0, length - suffix), end: length - 1 }
      : null;
  }
  const start = Number(parts[1]);
  const end = parts[2] ? Math.min(Number(parts[2]), length - 1) : length - 1;
  return start < length && start <= end ? { start, end } : null;
}
