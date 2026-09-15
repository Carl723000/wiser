import { expect, it } from 'vitest';
import { withBusinessFocus } from './exploration-business-focus';
it('does not carry graph focus into a different query or copy duplicate or invalid values', () => {
  const href = '/zh-CN/data-foundation/explore?query=next&view=graph';
  expect(withBusinessFocus(href, '?query=old&businessKind=POLICY')).toBe(href);
  expect(
    withBusinessFocus(
      href,
      '?query=next&businessKind=POLICY&businessKind=EVENT&businessEntity=bad',
    ),
  ).toBe(href);
});

it('keeps expanded observations across tabs only within the current query', () => {
  const href = '/zh-CN/data-foundation/explore?query=next&view=records';
  expect(withBusinessFocus(href, '?query=next&businessMode=all')).toBe(
    href + '&businessMode=all',
  );
  for (const search of [
    '?query=old&businessMode=all',
    '?query=next&businessMode=all&businessMode=all',
    '?query=next&businessMode=unknown',
  ])
    expect(withBusinessFocus(href, search)).toBe(href);
});

it('retains display focus when an opened saved view becomes its authorized query', () => {
  const href = '/zh-CN/data-foundation/explore?query=next&view=records';
  const opened = { viewId: 'saved-one', queryId: 'next' };
  expect(
    withBusinessFocus(
      href,
      '?saved=saved-one&businessMode=all&businessKind=POLICY',
      opened,
    ),
  ).toBe(href + '&businessMode=all&businessKind=POLICY');
  for (const search of [
    '?saved=other&businessMode=all',
    '?saved=saved-one&saved=saved-one&businessMode=all',
    '?saved=saved-one&query=old&businessMode=all',
  ])
    expect(withBusinessFocus(href, search, opened)).toBe(href);
  expect(
    withBusinessFocus(href, '?saved=saved-one&businessMode=all', {
      ...opened,
      queryId: 'old',
    }),
  ).toBe(href);
});

it('keeps valid reading pages and presentation only inside the same query', () => {
  const href = '/zh-CN/data-foundation/explore?query=next&view=map';
  expect(
    withBusinessFocus(
      href,
      '?query=next&businessPage=3&businessPresentation=network',
    ),
  ).toBe(href + '&businessPresentation=network&businessPage=3');
  expect(
    withBusinessFocus(
      href,
      '?query=old&businessPage=3&businessPresentation=network',
    ),
  ).toBe(href);
  expect(
    withBusinessFocus(
      href,
      '?query=next&businessPage=-1&businessPresentation=invalid',
    ),
  ).toBe(href);
});

it('retains bounded global layout controls only across the same authorized query', () => {
  const href = '/zh-CN/data-foundation/explore?query=next&view=map';
  const controls =
    '&businessLayout=circular&businessGrouping=source&businessNodeSpacing=80&businessGroupSpacing=400';
  expect(withBusinessFocus(href, 'query=next' + controls)).toBe(
    href + controls,
  );
  expect(withBusinessFocus(href, 'query=old' + controls)).toBe(href);
  expect(
    withBusinessFocus(
      href,
      'query=next&businessLayout=invalid&businessNodeSpacing=900&businessGrouping=kind&businessGrouping=source',
    ),
  ).toBe(href);
});
