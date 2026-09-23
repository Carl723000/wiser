import { ResourceAccessContextSchema } from '@wiser/platform-contracts';
import { ExternalMetadataInputSchema } from '@wiser/data-contracts';
import {
  DataCapabilityHandlerError,
  type DataCapabilityExecutionContext,
  type DataCapabilityExecutor,
  type DataCapabilityHandlerErrorCode,
} from './capability-handler.js';
import {
  ExternalMetadataError,
  type ExternalMetadataErrorCode,
  type ExternalMetadataReader,
} from './external-metadata.js';

const errors: Readonly<
  Record<ExternalMetadataErrorCode, DataCapabilityHandlerErrorCode>
> = {
  INVALID_INPUT: 'VALIDATION_FAILED',
  ACCESS_DENIED: 'FORBIDDEN',
  AUTHORIZATION_EXPIRED: 'EXTERNAL_AUTHORIZATION_EXPIRED',
  SOURCE_UNAVAILABLE: 'EXTERNAL_SOURCE_UNAVAILABLE',
  SOURCE_TIMEOUT: 'EXTERNAL_SOURCE_TIMEOUT',
  SOURCE_ACCESS_DENIED: 'EXTERNAL_SOURCE_ACCESS_DENIED',
  INVALID_METADATA: 'EXTERNAL_METADATA_INVALID',
  CANCELLED: 'REQUEST_CANCELLED',
};

/** A trusted host may supply a reader only after wiring live source-specific permission.
 * Default registration exposes the contract, not a provider credential or implicit grant.
 */
export function createExternalMetadataExecutor(
  reader?:
    | ExternalMetadataReader
    | ((
        sourceId: string,
        context: DataCapabilityExecutionContext,
      ) => Promise<ExternalMetadataReader | undefined>),
): DataCapabilityExecutor {
  return {
    id: 'data.external.metadata.read',
    async execute(input, context) {
      const request = ExternalMetadataInputSchema.safeParse(input);
      if (!request.success)
        throw new DataCapabilityHandlerError('VALIDATION_FAILED');
      if (context.authorization.resourceAccess !== undefined) {
        const access = ResourceAccessContextSchema.safeParse(
          context.authorization.resourceAccess,
        );
        if (
          !access.success ||
          access.data.scope.mode !== 'managed' ||
          access.data.scope.validUntil === null ||
          Date.parse(access.data.scope.validUntil) <= Date.now() ||
          !access.data.scope.permissions['external.directory'].some(
            (ref) =>
              ref.kind === 'external-source' &&
              ref.sourceId === request.data.sourceId,
          )
        )
          throw new DataCapabilityHandlerError('FORBIDDEN');
      }
      let selected: ExternalMetadataReader | undefined;
      try {
        selected =
          typeof reader === 'function'
            ? await reader(request.data.sourceId, context)
            : reader;
      } catch {
        throw new DataCapabilityHandlerError(
          context.signal.aborted
            ? 'REQUEST_CANCELLED'
            : 'EXTERNAL_SOURCE_UNAVAILABLE',
        );
      }
      if (!selected)
        throw new DataCapabilityHandlerError('EXTERNAL_SOURCE_UNCONFIGURED');
      try {
        return await selected.read(request.data, context);
      } catch (caught) {
        throw new DataCapabilityHandlerError(
          caught instanceof ExternalMetadataError
            ? errors[caught.code]
            : 'EXTERNAL_SOURCE_UNAVAILABLE',
        );
      }
    },
  };
}
