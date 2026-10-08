import { describe, expect, it } from 'vitest';
import type { DataCapabilityId } from '@wiser/data-contracts';
import { admitsManagedCapability } from '../src/data-foundation/managed-capability-policy.js';
describe('candidate relationship exact managed admission', () => {
  it.each(['create', 'get', 'list', 'review', 'withdraw', 'rebind'])(
    'admits the guarded %s path only',
    (operation) => {
      expect(
        admitsManagedCapability(
          `data.ingestion.candidate.relations.${operation}` as DataCapabilityId,
        ),
      ).toBe(true);
    },
  );
  it.each(['publish', 'delete', 'approve'])(
    'rejects the unimplemented %s path',
    (operation) => {
      expect(
        admitsManagedCapability(
          `data.ingestion.candidate.relations.${operation}` as DataCapabilityId,
        ),
      ).toBe(false);
    },
  );
  it('preserves denial of published import and broad ingestion approval', () => {
    expect(admitsManagedCapability('data.knowledge.relations.import')).toBe(
      false,
    );
    expect(admitsManagedCapability('data.ingestion.approve')).toBe(false);
  });
});
