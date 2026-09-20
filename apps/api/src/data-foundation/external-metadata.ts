import { z } from 'zod';
import {
  ExternalMetadataInputSchema,
  ExternalMetadataOutputSchema,
  ExternalStationMetadataSchema,
  type ExternalMetadataInput,
  type ExternalMetadataOutput,
  SecurityLevelSchema,
} from '@wiser/data-contracts';
import { PlatformUuidSchema } from '@wiser/platform-contracts';
import type { DataCapabilityExecutionContext } from './capability-handler.js';

const FieldSchema = z.enum(['stationCode', 'year', 'province', 'city']);
type MetadataField = z.infer<typeof FieldSchema>;
const GrantSchema = z.strictObject({
  sourceId: PlatformUuidSchema,
  actorId: PlatformUuidSchema,
  actorType: z.enum(['human', 'agent', 'service']),
  delegatedBy: PlatformUuidSchema.optional(),
  tenantId: PlatformUuidSchema,
  projectId: PlatformUuidSchema,
  purpose: z.string().min(1).max(256),
  authzVersion: z.number().int().nonnegative(),
  policyVersion: z.string().min(1).max(128),
  expiresAt: z.iso.datetime({ offset: true }),
  fromYear: z.number().int().min(1800).max(2200),
  toYear: z.number().int().min(1800).max(2200),
  fields: z.array(FieldSchema).min(2).max(4),
  securityLevel: SecurityLevelSchema,
});
const LevelRank = {
  L0_PUBLIC: 0,
  L1_INTERNAL: 1,
  L2_RESTRICTED: 2,
  L3_CONFIDENTIAL: 3,
} as const;

export type ExternalMetadataErrorCode =
  | 'INVALID_INPUT'
  | 'ACCESS_DENIED'
  | 'AUTHORIZATION_EXPIRED'
  | 'SOURCE_UNAVAILABLE'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_ACCESS_DENIED'
  | 'INVALID_METADATA'
  | 'CANCELLED';
export class ExternalMetadataError extends Error {
  constructor(readonly code: ExternalMetadataErrorCode) {
    super(code);
    this.name = 'ExternalMetadataError';
  }
}

/** Trusted host port: resolve current provider permission AND live WISER authority.
 * Never construct grants from request JSON or treat shared provider credentials as a grant.
 * Return null after revocation, project membership loss, or a policy lookup failure.
 */
export interface ExternalMetadataAccessPort {
  resolve(
    context: DataCapabilityExecutionContext,
    sourceId: string,
  ): Promise<unknown>;
}
/** A bounded, metadata-only provider adapter. The HTTP adapter owns response-byte limits,
 * fixed endpoint/redirect policy, credential handling, and normalization; never log raw pages.
 */
export interface ExternalMetadataProviderPort {
  readPage(input: {
    readonly request: ExternalMetadataInput;
    readonly fields: readonly MetadataField[];
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}
export interface ExternalMetadataReaderOptions {
  readonly access: ExternalMetadataAccessPort;
  readonly provider: ExternalMetadataProviderPort;
  readonly now?: () => number;
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new ExternalMetadataError('CANCELLED');
}

/** Even a broken adapter that ignores its signal must not hold an abandoned request open. */
async function cancellable<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  checkSignal(signal);
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ExternalMetadataError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      stopped,
    ]);
    checkSignal(signal);
    return result;
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

export class ExternalMetadataReader {
  readonly #options: ExternalMetadataReaderOptions;
  constructor(options: ExternalMetadataReaderOptions) {
    this.#options = options;
  }

  async #authorize(
    request: ExternalMetadataInput,
    context: DataCapabilityExecutionContext,
  ) {
    let value: unknown;
    try {
      value = await cancellable(context.signal, () =>
        this.#options.access.resolve(context, request.sourceId),
      );
    } catch {
      checkSignal(context.signal);
      throw new ExternalMetadataError('ACCESS_DENIED');
    }
    const parsed = GrantSchema.safeParse(value);
    const time = (this.#options.now ?? Date.now)();
    if (!parsed.success || !Number.isFinite(time))
      throw new ExternalMetadataError('ACCESS_DENIED');
    const grant = parsed.data;
    const auth = context.authorization;
    if (
      grant.sourceId !== request.sourceId ||
      grant.actorId !== context.principal.actorId ||
      grant.actorType !== context.principal.actorType ||
      grant.delegatedBy !== context.principal.delegatedBy ||
      grant.tenantId !== auth.tenantId ||
      grant.projectId !== auth.projectId ||
      grant.purpose !== auth.purpose ||
      grant.authzVersion !== auth.authzVersion ||
      !auth.scopes.includes('data.catalog.read') ||
      LevelRank[grant.securityLevel] >
        LevelRank[context.effectiveMaxSecurityLevel] ||
      LevelRank[grant.securityLevel] > LevelRank[auth.maxSecurityLevel] ||
      request.fromYear < grant.fromYear ||
      request.toYear > grant.toYear ||
      !grant.fields.includes('stationCode') ||
      !grant.fields.includes('year') ||
      new Set(grant.fields).size !== grant.fields.length
    ) {
      throw new ExternalMetadataError('ACCESS_DENIED');
    }
    if (Date.parse(grant.expiresAt) <= time)
      throw new ExternalMetadataError('AUTHORIZATION_EXPIRED');
    return { grant, time };
  }

  async read(
    input: unknown,
    context: DataCapabilityExecutionContext,
  ): Promise<ExternalMetadataOutput> {
    checkSignal(context.signal);
    const parsed = ExternalMetadataInputSchema.safeParse(input);
    if (!parsed.success) throw new ExternalMetadataError('INVALID_INPUT');
    const request = parsed.data;
    const before = await this.#authorize(request, context);
    let raw: unknown;
    try {
      raw = await cancellable(context.signal, () =>
        this.#options.provider.readPage({
          request: { ...request },
          fields: [...before.grant.fields],
          signal: context.signal,
        }),
      );
    } catch (error) {
      checkSignal(context.signal);
      if (
        error instanceof ExternalMetadataError &&
        ['SOURCE_ACCESS_DENIED', 'SOURCE_TIMEOUT', 'INVALID_METADATA'].includes(
          error.code,
        )
      )
        throw new ExternalMetadataError(error.code);
      throw new ExternalMetadataError('SOURCE_UNAVAILABLE');
    }
    const after = await this.#authorize(request, context);
    if (JSON.stringify(before.grant) !== JSON.stringify(after.grant))
      throw new ExternalMetadataError('ACCESS_DENIED');
    const page = z
      .object({
        items: z.array(z.record(z.string(), z.unknown())).max(request.limit),
        total: z.number().int().min(0).max(1_000_000),
      })
      .safeParse(raw);
    if (
      !page.success ||
      page.data.total < request.offset + page.data.items.length ||
      (page.data.items.length === 0 && page.data.total !== request.offset)
    )
      throw new ExternalMetadataError('INVALID_METADATA');
    const keys = new Set<string>();
    const items = page.data.items.map((row) => {
      const record = ExternalStationMetadataSchema.safeParse(
        Object.fromEntries(
          before.grant.fields.map((field) => [field, row[field]]),
        ),
      );
      if (
        !record.success ||
        before.grant.fields.some((field) => record.data[field] === undefined) ||
        record.data.year < request.fromYear ||
        record.data.year > request.toYear
      )
        throw new ExternalMetadataError('INVALID_METADATA');
      const key = JSON.stringify([record.data.stationCode, record.data.year]);
      if (keys.has(key)) throw new ExternalMetadataError('INVALID_METADATA');
      keys.add(key);
      return record.data;
    });
    const end = request.offset + items.length;
    return ExternalMetadataOutputSchema.parse({
      sourceId: request.sourceId,
      status: items.length ? 'AVAILABLE' : 'EMPTY',
      items,
      total: page.data.total,
      ...(end < page.data.total ? { nextOffset: end } : {}),
      checkedAt: new Date(after.time).toISOString(),
      timePrecision: 'year',
    });
  }
}
