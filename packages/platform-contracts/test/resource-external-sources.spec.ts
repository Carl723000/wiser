import { expect, it } from 'vitest';
import {
  ExternalSourceManagementPageSchema,
  ExternalSourceManagementQuerySchema,
} from '../src/resource-external-sources.ts';

const id = 'e3000000-0000-4000-8000-000000000001';

it('bounds external source management pages and keeps provider and WISER states distinct', () => {
  expect(
    ExternalSourceManagementQuerySchema.safeParse({ offset: 0, limit: 21 })
      .success,
  ).toBe(false);
  const parsed = ExternalSourceManagementPageSchema.parse({
    items: [
      {
        sourceId: id,
        name: '合成站点目录',
        provider: '合成供方',
        providerPermissionStatus: 'VERIFIED',
        allowedFields: ['stationCode', 'year'],
        allowedActions: ['source.discover', 'external.directory'],
        fromYear: 2020,
        toYear: 2025,
        expiresAt: '2099-01-01T00:00:00Z',
        licenseBasis: 'Synthetic provider permission',
        eligibleForProposal: true,
        connectionStatus: 'UNKNOWN',
        wiserPolicyStatus: 'none',
        policyId: null,
        expectedPolicyVersion: 0,
      },
    ],
    hasMore: false,
    checkedAt: '2026-09-23T00:00:00Z',
    managementRoleOptions: ['data-steward'],
    canPropose: true,
  });
  expect(parsed.items[0]?.providerPermissionStatus).toBe('VERIFIED');
  expect(parsed.items[0]?.wiserPolicyStatus).toBe('none');
  expect(
    ExternalSourceManagementPageSchema.safeParse({
      ...parsed,
      items: [{ ...parsed.items[0], credential: 'secret' }],
    }).success,
  ).toBe(false);
});
