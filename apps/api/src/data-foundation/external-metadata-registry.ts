import { z } from 'zod';
import { SecurityLevelSchema } from '@wiser/data-contracts';
import {
  PlatformUuidSchema,
  ResourceAccessContextSchema,
  type PlatformRequestContext,
} from '@wiser/platform-contracts';
import type { DataCapabilityExecutionContext } from './capability-handler.js';
import {
  ExternalMetadataReader,
  type ExternalMetadataProviderPort,
} from './external-metadata.js';

const Field = z.enum(['stationCode', 'year', 'province', 'city']);
const Action = z.enum(['source.discover', 'external.directory']);
const Permission = z.strictObject({
  status: z.literal('VERIFIED'),
  policyVersion: z.string().min(1).max(128),
  basis: z.string().trim().min(5).max(1000),
  startsAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  fromYear: z.number().int().min(1800).max(2200),
  toYear: z.number().int().min(1800).max(2200),
  fields: z.array(Field).min(2).max(4),
  actions: z.array(Action).min(1).max(2),
  securityLevel: SecurityLevelSchema,
});
const RecordSchema = z.strictObject({
  sourceId: PlatformUuidSchema,
  tenantId: PlatformUuidSchema,
  projectId: PlatformUuidSchema,
  bindingVersion: z.string().min(1).max(128),
  providerPermission: Permission,
});
const LevelRank = {
  L0_PUBLIC: 0,
  L1_INTERNAL: 1,
  L2_RESTRICTED: 2,
  L3_CONFIDENTIAL: 3,
} as const;
type RegisteredSource = z.infer<typeof RecordSchema> & {
  provider: ExternalMetadataProviderPort;
};

/** This port is implemented only by the trusted host. It must look up a
 * registered source and current supplier permission on every call. No request
 * URL, bearer token or provider response may populate this record. */
export interface TrustedExternalMetadataRegistry {
  resolve(
    context: PlatformRequestContext,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function parse(value: unknown): RegisteredSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { provider, ...metadata } = value as Record<string, unknown>;
  const record = RecordSchema.safeParse(metadata);
  if (
    !record.success ||
    !provider ||
    typeof provider !== 'object' ||
    typeof (provider as { readPage?: unknown }).readPage !== 'function'
  )
    return null;
  const permission = record.data.providerPermission;
  if (
    permission.fromYear > permission.toYear ||
    !permission.fields.includes('stationCode') ||
    !permission.fields.includes('year') ||
    new Set(permission.fields).size !== permission.fields.length ||
    new Set(permission.actions).size !== permission.actions.length ||
    Date.parse(permission.startsAt) >= Date.parse(permission.expiresAt)
  )
    return null;
  return { ...record.data, provider: provider as ExternalMetadataProviderPort };
}

/** Host-injected source registry adapter. It creates no platform grant: a
 * separate WISER action and verified supplier permission are both required. */
export function createTrustedExternalMetadataPorts(
  registry: TrustedExternalMetadataRegistry,
  options: { now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const get = async (
    context: PlatformRequestContext,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<RegisteredSource | null> => {
    if (signal.aborted) return null;
    try {
      const record = parse(await registry.resolve(context, sourceId, signal));
      const time = now();
      if (
        signal.aborted ||
        !record ||
        !Number.isFinite(time) ||
        record.sourceId !== sourceId ||
        record.tenantId !== context.authorization.tenantId ||
        record.projectId !== context.authorization.projectId ||
        LevelRank[record.providerPermission.securityLevel] >
          LevelRank[context.authorization.maxSecurityLevel] ||
        Date.parse(record.providerPermission.startsAt) > time ||
        Date.parse(record.providerPermission.expiresAt) <= time
      )
        return null;
      return record;
    } catch {
      return null;
    }
  };
  const hasManagedAction = (
    context: DataCapabilityExecutionContext,
    sourceId: string,
  ) => {
    const parsed = ResourceAccessContextSchema.safeParse(
      context.authorization.resourceAccess,
    );
    return (
      parsed.success &&
      parsed.data.scope.mode === 'managed' &&
      parsed.data.scope.validUntil !== null &&
      Date.parse(parsed.data.scope.validUntil) > now() &&
      parsed.data.scope.permissions['external.directory'].some(
        (ref) => ref.kind === 'external-source' && ref.sourceId === sourceId,
      )
    );
  };
  return {
    async validateExternalSource(input: {
      context: PlatformRequestContext;
      sourceId: string;
      actions: readonly string[];
      licenseBasis: string;
      policyWindow?: { readonly startsAt: string; readonly expiresAt: string };
      signal: AbortSignal;
    }): Promise<boolean> {
      const record = await get(input.context, input.sourceId, input.signal);
      return (
        record !== null &&
        input.licenseBasis.trim() === record.providerPermission.basis &&
        (!input.policyWindow ||
          (Number.isFinite(Date.parse(input.policyWindow.startsAt)) &&
            Number.isFinite(Date.parse(input.policyWindow.expiresAt)) &&
            Date.parse(input.policyWindow.startsAt) <
              Date.parse(input.policyWindow.expiresAt) &&
            Date.parse(input.policyWindow.startsAt) >=
              Date.parse(record.providerPermission.startsAt) &&
            Date.parse(input.policyWindow.expiresAt) <=
              Date.parse(record.providerPermission.expiresAt))) &&
        input.actions.every((action) =>
          record.providerPermission.actions.includes(
            action as 'source.discover',
          ),
        ) &&
        !input.signal.aborted
      );
    },
    async resolveReader(
      sourceId: string,
      context: DataCapabilityExecutionContext,
    ): Promise<ExternalMetadataReader | undefined> {
      if (!hasManagedAction(context, sourceId)) return undefined;
      const initial = await get(context, sourceId, context.signal);
      if (
        !initial ||
        !initial.providerPermission.actions.includes('external.directory')
      )
        return undefined;
      return new ExternalMetadataReader({
        now,
        provider: initial.provider,
        access: {
          resolve: async (current, requestedSourceId) => {
            if (
              requestedSourceId !== sourceId ||
              !hasManagedAction(current, sourceId)
            )
              return null;
            const live = await get(current, sourceId, current.signal);
            if (
              !live ||
              live.bindingVersion !== initial.bindingVersion ||
              live.providerPermission.policyVersion !==
                initial.providerPermission.policyVersion ||
              !live.providerPermission.actions.includes('external.directory')
            )
              return null;
            const access = ResourceAccessContextSchema.parse(
              current.authorization.resourceAccess,
            );
            if (access.scope.mode !== 'managed' || !access.scope.validUntil)
              return null;
            const permission = live.providerPermission;
            const expiresAt = new Date(
              Math.min(
                Date.parse(permission.expiresAt),
                Date.parse(access.scope.validUntil),
              ),
            ).toISOString();
            return {
              sourceId,
              actorId: current.principal.actorId,
              actorType: current.principal.actorType,
              ...(current.principal.delegatedBy
                ? { delegatedBy: current.principal.delegatedBy }
                : {}),
              tenantId: current.authorization.tenantId,
              projectId: current.authorization.projectId,
              purpose: current.authorization.purpose,
              authzVersion: current.authorization.authzVersion,
              policyVersion: permission.policyVersion,
              expiresAt,
              fromYear: permission.fromYear,
              toYear: permission.toYear,
              fields: permission.fields,
              securityLevel: permission.securityLevel,
            };
          },
        },
      });
    },
  };
}
