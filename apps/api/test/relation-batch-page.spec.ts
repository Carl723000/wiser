import { expect, it } from 'vitest';
import { boundedRelationPage } from '../src/data-foundation/relation-batch-page.js';
const rows = Array.from({ length: 503 }, (_, i) => ({
  assertionId: String(i),
  evidence: '河段原文🙂'.repeat((i % 3) + 1),
}));
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');
it('preserves all identities and evidence across 250/500 pages and an uneven final page', () => {
  for (const first of [250, 500]) {
    const gathered: typeof rows = [];
    let offset = 0;
    do {
      const page = boundedRelationPage(rows, offset, first);
      expect(page.totalCount).toBe(rows.length);
      expect(page.items.length).toBeLessThanOrEqual(first);
      expect(page.items.length).toBeGreaterThan(0);
      gathered.push(...page.items);
      offset += page.items.length;
      expect(page.nextCursor).toBe(
        offset < rows.length ? rows[offset - 1]!.assertionId : undefined,
      );
    } while (offset < rows.length);
    expect(gathered).toEqual(rows);
  }
});
it('counts UTF-8, escaped strings, separators, total and cursor in the complete JSON budget', () => {
  const input = [
    { assertionId: 'a', evidence: '河🙂\n"' },
    { assertionId: 'b', evidence: 'more' },
  ];
  const first = { items: [input[0]], totalCount: 2, nextCursor: 'a' };
  expect(boundedRelationPage(input, 0, 500, bytes(first))).toEqual(first);
  expect(() => boundedRelationPage(input, 0, 500, bytes(first) - 1)).toThrow();
  const last = { items: [input[1]], totalCount: 2 };
  expect(boundedRelationPage(input, 1, 500, bytes(last))).toEqual(last);
});
it('returns a resumable prefix when later evidence is too large and then fails explicitly', () => {
  const input = [
    { assertionId: 'small', evidence: 'one' },
    { assertionId: 'big', evidence: 'x'.repeat(2000) },
  ];
  expect(boundedRelationPage(input, 0, 500, 180)).toEqual({
    items: [input[0]],
    totalCount: 2,
    nextCursor: 'small',
  });
  expect(() => boundedRelationPage(input, 1, 500, 180)).toThrow(
    'Relation exceeds response budget',
  );
});
it('returns no cursor for empty/end scopes and rejects invalid bounds', () => {
  expect(boundedRelationPage([], 0, 500)).toEqual({ items: [], totalCount: 0 });
  expect(boundedRelationPage(rows, rows.length, 500)).toEqual({
    items: [],
    totalCount: rows.length,
  });
  for (const [offset, first] of [
    [-1, 100],
    [504, 100],
    [0, 501],
    [0, 0],
    [0, 1.2],
  ])
    expect(() => boundedRelationPage(rows, offset!, first!)).toThrow();
});
