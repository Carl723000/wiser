import type { ResourceAdministrationOptions } from '@wiser/platform-auth';
import type { QueryAdapterPgPool } from './query-adapters.js';
export function createDataResourcePackageValidator(
  _pool: QueryAdapterPgPool,
): ResourceAdministrationOptions['validatePackage'] {
  return () => Promise.resolve(false);
}
