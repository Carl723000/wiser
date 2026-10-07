import { describe, expect, it } from 'vitest';
import type { DataCapabilityId } from '@wiser/data-contracts';
import { admitsManagedCapability } from '../src/data-foundation/managed-capability-policy.js';
describe('fixed topic managed dispatch', () => {
  it.each(['create', 'list', 'open'])(
    'admits only the guarded topic %s capability',
    (operation) => {
      expect(
        admitsManagedCapability(
          `data.ingestion.candidate.topic.${operation}` as DataCapabilityId,
        ),
      ).toBe(true);
    },
  );
  it('preserves the rejection of unguarded candidate write and maintenance paths', () => {
    expect(admitsManagedCapability('data.ingestion.approve')).toBe(false);
    expect(admitsManagedCapability('data.ingestion.resume')).toBe(false);
  });
});
