import { expect, it } from 'vitest';
import {
  readGraphLayoutSettings,
  writeGraphLayoutSettings,
} from './graph-layout-settings';
it('bounds display settings and round-trips layouts without copying unrelated parameters', () => {
  const value = {
    layout: 'circular',
    grouping: 'kind',
    nodeSpacing: 80,
    groupSpacing: 400,
  } as const;
  const params = new URLSearchParams('query=original');
  writeGraphLayoutSettings(params, value);
  expect(readGraphLayoutSettings(params)).toEqual(value);
  expect(params.get('query')).toBe('original');
  for (const suffix of [
    'businessNodeSpacing=-20',
    'businessNodeSpacing=999999',
    'businessNodeSpacing=40&businessNodeSpacing=80',
    'businessGrouping=invalid',
    'businessLayout=unknown',
  ])
    expect(readGraphLayoutSettings(new URLSearchParams(suffix))).toEqual({
      layout: 'network',
      grouping: 'topology',
      nodeSpacing: 40,
      groupSpacing: 200,
    });
});
