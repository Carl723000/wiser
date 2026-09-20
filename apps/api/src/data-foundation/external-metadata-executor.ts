import {
  DataCapabilityHandlerError,
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
  reader?: ExternalMetadataReader,
): DataCapabilityExecutor {
  return {
    id: 'data.external.metadata.read',
    async execute(input, context) {
      if (!reader)
        throw new DataCapabilityHandlerError('EXTERNAL_SOURCE_UNCONFIGURED');
      try {
        return await reader.read(input, context);
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
