import { expect, it } from 'vitest';
import { readBusinessReading, readingPage } from './business-reading';

it('pages exact assertion identities without losing rows or splitting the stable order', () => {
  const rows = Array.from({ length: 17 }, (_, i) => ({ assertionId: `r${i}` }));
  const pages = [1, 2, 3].map((page) => readingPage(rows, page));
  expect(pages.map((p) => p.rows.length)).toEqual([6, 6, 5]);
  expect(pages.flatMap((p) => p.rows)).toEqual(rows);
  expect(readingPage(rows, 999).page).toBe(3);
  expect(readingPage([], 1)).toMatchObject({ page: 1, count: 1, rows: [] });
});
it('accepts only unambiguous bounded reading state', () => {
  expect(
    readBusinessReading(
      new URLSearchParams('businessPage=2&businessPresentation=network'),
    ),
  ).toEqual({ page: 2, presentation: 'network' });
  for (const value of ['-1', '0', 'NaN', '10001', '2.5', '1&businessPage=2'])
    expect(
      readBusinessReading(new URLSearchParams('businessPage=' + value)).page,
    ).toBe(1);
  expect(
    readBusinessReading(
      new URLSearchParams(
        'businessPresentation=network&businessPresentation=network',
      ),
    ).presentation,
  ).toBe('reading');
});

it('opens the complete network by default and retains explicitly requested reading', () => {
  expect(readBusinessReading(new URLSearchParams()).presentation).toBe(
    'network',
  );
  expect(
    readBusinessReading(new URLSearchParams('businessPresentation=reading'))
      .presentation,
  ).toBe('reading');
});
