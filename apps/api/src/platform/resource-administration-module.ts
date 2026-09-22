import type { PostgresResourceAdministrationService } from '@wiser/platform-auth';
import type { WiserApiModule } from './modules.js';
export type ResourceAdministrationHttpService = Pick<
  PostgresResourceAdministrationService,
  'definitions' | 'savePackage' | 'savePreset'
>;
export function createResourceAdministrationModule(
  _service: ResourceAdministrationHttpService,
): WiserApiModule {
  return { id: 'platform.resource-administration', register() {} };
}
