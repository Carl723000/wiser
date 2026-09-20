import { expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { externalSourceBinding } from './external-source-binding.server';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = {
  tenantId: id(1),
  projectId: id(2),
  dataItemId: id(3),
  sourceId: id(4),
};
const scope = { tenantId: id(1), projectId: id(2) };
it('requires an explicit complete scoped mapping, never a document name', () => {
  expect(
    externalSourceBinding(JSON.stringify([binding]), scope, id(3)),
  ).toEqual({ sourceId: id(4) });
  expect(
    externalSourceBinding(JSON.stringify([binding]), scope, id(9)),
  ).toBeNull();
  expect(
    externalSourceBinding(
      JSON.stringify([binding]),
      { ...scope, projectId: id(9) },
      id(3),
    ),
  ).toBeNull();
  expect(
    externalSourceBinding(
      JSON.stringify([binding]),
      { ...scope, tenantId: id(9) },
      id(3),
    ),
  ).toBeNull();
});
it.each([
  undefined,
  '',
  '{',
  JSON.stringify([{ ...binding, token: 'secret' }]),
  JSON.stringify([{ ...binding, sourceId: 'https://example.test' }]),
  JSON.stringify([binding, binding]),
  JSON.stringify([{ ...binding, sourceId: id(5) }, binding]),
  JSON.stringify(Array.from({ length: 101 }, () => binding)),
])('ignores missing, invalid or ambiguous host configuration', (value) => {
  expect(externalSourceBinding(value, scope, id(3))).toBeNull();
});
