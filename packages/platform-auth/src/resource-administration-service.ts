import type {
  PlatformRequestContext,
  ResourcePackageCommand,
  ResourcePresetCommand,
  ResourceDefinitionReceipt,
} from '@wiser/platform-contracts';
import type { SupabaseJwtClaimsVerifier } from './index.js';
import type { PlatformDelegationTransactionPool } from './postgres-platform-delegation-service.js';
export interface ResourceAdministrationOptions {
  readonly pool: PlatformDelegationTransactionPool;
  readonly verifyHuman: SupabaseJwtClaimsVerifier;
  readonly validatePackage: (input: {
    context: PlatformRequestContext;
    command: ResourcePackageCommand;
  }) => Promise<boolean>;
}
export class ResourceAdministrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ResourceAdministrationError';
  }
}
export class PostgresResourceAdministrationService {
  constructor(_options: ResourceAdministrationOptions) {}
  savePackage(_input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePackageCommand;
  }): Promise<ResourceDefinitionReceipt> {
    return Promise.reject(new ResourceAdministrationError('NOT_IMPLEMENTED'));
  }
  savePreset(_input: {
    token: string;
    idempotencyKey: string;
    command: ResourcePresetCommand;
  }): Promise<ResourceDefinitionReceipt> {
    return Promise.reject(new ResourceAdministrationError('NOT_IMPLEMENTED'));
  }
}
