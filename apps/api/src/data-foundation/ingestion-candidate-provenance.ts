import type { DataCapabilityExecutionContext } from './capability-handler.js';
import type { QueryAdapterPgPool } from './query-adapters.js';

/** Unregistered reader: public admission is integrated by the application owner. */
export function createCandidateConversionProvenanceReader(
  _pool: QueryAdapterPgPool,
) {
  return {
    id: 'data.ingestion.candidate.provenance.get' as const,
    async execute(
      _input: unknown,
      _context: DataCapabilityExecutionContext,
    ): Promise<unknown> {
      throw Object.assign(new Error('Conversion provenance unavailable.'), {
        code: 'NOT_FOUND',
      });
    },
  };
}
