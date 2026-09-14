import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RelationListInputSchema } from '../src/knowledge-relations/index.js';

it('accepts an existing authorized exploration scope without repeating source IDs in the URL', () => {
  expect(RelationListInputSchema.safeParse({ queryId: randomUUID(), status: 'PENDING_REVIEW' }).success).toBe(true);
});
it('rejects missing and competing scope definitions', () => {
  const source = { dataItemId: randomUUID(), versionId: randomUUID() };
  for (const input of [{}, {queryId: randomUUID(), ...source}, {queryId: randomUUID(), relatedSources:[source]}, {dataItemId: source.dataItemId}])
    expect(RelationListInputSchema.safeParse(input).success).toBe(false);
});
