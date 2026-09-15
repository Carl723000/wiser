import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { RelationEvidenceSchema } from '../src/knowledge-relations/index.js';

const evidence = {
  assetId: randomUUID(),
  sourceHash: 'a'.repeat(64),
  locator: 'record:product-start-time',
  excerpt: '2026-08-24',
  polarity: 'SUPPORTS',
};
const source = {
  dataItemId: randomUUID(),
  versionId: randomUUID(),
  analysisId: randomUUID(),
  recordId: randomUUID(),
};
it('accepts an explicitly pinned external evidence record without changing legacy evidence', () => {
  expect(RelationEvidenceSchema.parse(evidence)).toEqual(evidence);
  expect(
    RelationEvidenceSchema.safeParse({ ...evidence, source }).success,
  ).toBe(true);
});
it('refuses incomplete or opaque external evidence references', () => {
  for (const bad of [
    null,
    {},
    { ...source, recordId: undefined },
    { ...source, analysisId: 'latest' },
    { ...source, url: 'https://example.test' },
  ]) {
    expect(
      RelationEvidenceSchema.safeParse({ ...evidence, source: bad }).success,
    ).toBe(false);
  }
});
