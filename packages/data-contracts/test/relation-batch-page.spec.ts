import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { expect, it } from 'vitest';
import {
  DATA_CAPABILITY_ARCHIVE,
  DATA_CAPABILITY_REGISTRY,
} from '../src/index.js';

const current = DATA_CAPABILITY_REGISTRY['data.knowledge.relations.list'];
it('advertises an opt-in bounded project page without expanding legacy requests', () => {
  expect(current.version).toBe('1.7.0');
  for (const first of [100, 250, 500])
    expect(
      current.inputSchema.safeParse({
        queryId: randomUUID(),
        pageMode: 'BOUNDED_PROJECT',
        first,
      }).success,
    ).toBe(true);
  for (const input of [
    { queryId: randomUUID(), first: 101 },
    { queryId: randomUUID(), pageMode: 'BOUNDED_PROJECT', first: 501 },
    {
      dataItemId: randomUUID(),
      versionId: randomUUID(),
      pageMode: 'BOUNDED_PROJECT',
      first: 250,
    },
    { pageMode: 'BOUNDED_PROJECT', first: 250 },
  ])
    expect(current.inputSchema.safeParse(input).success).toBe(false);
});
it('archives the exact published 1.6 schemas with the 100-item boundary', () => {
  const prior = DATA_CAPABILITY_ARCHIVE['data.knowledge.relations.list']?.find(
    (c) => c.version === '1.6.0',
  );
  expect(prior).toBeDefined();
  expect(
    prior?.inputSchema.safeParse({ queryId: randomUUID(), first: 100 }).success,
  ).toBe(true);
  expect(
    prior?.inputSchema.safeParse({ queryId: randomUUID(), first: 101 }).success,
  ).toBe(false);
  expect(
    prior?.inputSchema.safeParse({
      queryId: randomUUID(),
      pageMode: 'BOUNDED_PROJECT',
      first: 100,
    }).success,
  ).toBe(false);
  const hash = (schema: z.ZodType) =>
    createHash('sha256')
      .update(JSON.stringify(z.toJSONSchema(schema)))
      .digest('hex');
  expect(prior && hash(prior.inputSchema)).toBe(
    '28f04197b8ae8f5fb1245500a4ee4e93949557975bb07196083a6d3aa42918bc',
  );
  expect(prior && hash(prior.outputSchema)).toBe(
    'cd446783c33bf9e8db1798aa8f2378b11f183480e7d709898728a60a99bacdd2',
  );
});
