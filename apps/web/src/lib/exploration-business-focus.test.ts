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
