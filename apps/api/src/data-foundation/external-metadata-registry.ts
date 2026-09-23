import { z } from 'zod';
import { SecurityLevelSchema } from '@wiser/data-contracts';
import {
  ExternalSourceManagementQuerySchema,
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
const SourceId = PlatformUuidSchema.refine(
  (value) => value === value.toLowerCase(),
);
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
  sourceId: SourceId,
  tenantId: PlatformUuidSchema,
  projectId: PlatformUuidSchema,
  bindingVersion: z.string().min(1).max(128),
  managementVisible: z.boolean().optional(),
  /** A non-secret, staff-displayable reference equal to the verified basis. */
  managementLicenseBasis: z.string().trim().min(5).max(1000).optional(),
  providerPermission: Permission,
});
const ListedSchema = z.strictObject({
  sourceId: SourceId,
  tenantId: PlatformUuidSchema,
  projectId: PlatformUuidSchema,
  name: z.string().trim().min(1).max(160),
  providerName: z.string().trim().min(1).max(160),
  securityLevel: SecurityLevelSchema,
  managementVisible: z.literal(true),
  providerPermissionStatus: z.enum([
    'VERIFIED',
    'PENDING',
    'EXPIRED',
    'REVOKED',
    'UNKNOWN',
  ]),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});
const ListedPageSchema = z.strictObject({
  items: z.array(ListedSchema).max(20),
  hasMore: z.boolean(),
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
  /** Optional host-owned, project-scoped management listing. Omission is an
   * empty, unavailable-to-propose directory, never a fallback to Data catalog. */
  list?(
    context: PlatformRequestContext,
    page: { offset: number; limit: number },
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
    requireReaderClearance = true,
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
        (!requireReaderClearance &&
          (record.managementVisible !== true ||
            record.managementLicenseBasis !==
              record.providerPermission.basis)) ||
        (requireReaderClearance &&
          LevelRank[record.providerPermission.securityLevel] >
            LevelRank[context.authorization.maxSecurityLevel]) ||
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
    async listManagementSources(input: {
      context: PlatformRequestContext;
      page: { offset: number; limit: number };
      signal: AbortSignal;
    }) {
      const page = ExternalSourceManagementQuerySchema.parse(input.page);
      if (!registry.list || input.signal.aborted)
        return { items: [], hasMore: false };
      const raw = ListedPageSchema.parse(
        await registry.list(input.context, page, input.signal),
      );
      if (input.signal.aborted) throw new Error('Source list cancelled');
      const ids = raw.items.map((item) => item.sourceId);
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate source');
      const auth = input.context.authorization;
      if (
        raw.items.some(
          (item) =>
            item.tenantId !== auth.tenantId ||
            item.projectId !== auth.projectId ||
            !item.managementVisible,
        )
      )
        throw new Error('Out-of-scope source');
      const items = await Promise.all(
        raw.items.map(async (item) => {
          const live =
            item.providerPermissionStatus === 'VERIFIED'
              ? await get(input.context, item.sourceId, input.signal, false)
              : null;
          const active =
            live !== null &&
            live.providerPermission.actions.some(
              (action) =>
                action === 'source.discover' || action === 'external.directory',
            );
          const permission = live?.providerPermission;
          return {
            sourceId: item.sourceId,
            name: item.name,
            provider: item.providerName,
            providerPermissionStatus: permission
              ? ('VERIFIED' as const)
              : item.providerPermissionStatus === 'VERIFIED'
                ? item.expiresAt && Date.parse(item.expiresAt) <= now()
                  ? ('EXPIRED' as const)
                  : ('UNKNOWN' as const)
                : item.providerPermissionStatus,
            allowedFields: permission ? [...permission.fields] : [],
            allowedActions: permission ? [...permission.actions] : [],
            fromYear: permission?.fromYear ?? null,
            toYear: permission?.toYear ?? null,
            expiresAt: permission?.expiresAt ?? item.expiresAt,
            licenseBasis: live?.managementLicenseBasis ?? null,
            eligibleForProposal: active,
          };
        }),
      );
      if (input.signal.aborted) throw new Error('Source list cancelled');
      return { items, hasMore: raw.hasMore };
    },
    async validateExternalSource(input: {
      context: PlatformRequestContext;
      sourceId: string;
      actions: readonly string[];
      licenseBasis: string;
      policyWindow?: { readonly startsAt: string; readonly expiresAt: string };
      signal: AbortSignal;
    }): Promise<boolean> {
      if (!registry.list) return false;
      const record = await get(
        input.context,
        input.sourceId,
        input.signal,
        false,
      );
      return (
        record !== null &&
        record.managementVisible === true &&
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
