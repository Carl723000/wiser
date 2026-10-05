import { expect, it } from 'vitest';
import {
  assertCandidateBackflowReporter,
  readCandidateBackflowTarget,
} from '../../apps/web/e2e-live/support/candidate-backflow-fixture.ts';

// Synthetic parser/discovery identities; these never authorize or run a browser chain.
const ingestionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const viewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const origin = 'http://127.0.0.1:3100';
const path = `/zh-CN/data-foundation/ingestions/${ingestionId}`;
const target = `${origin}${path}?candidateView=${viewId}`;

it.each([
  { locale: 'zh-CN', host: '127.0.0.1' },
  { locale: 'en', host: 'localhost' },
] as const)(
  'accepts a canonical same-origin $locale fixed view',
  ({ locale, host }) => {
    const base = `http://${host}:3100`;
    const destination = `/${locale}/data-foundation/ingestions/${ingestionId}?candidateView=${viewId}`;
    expect(readCandidateBackflowTarget(base, base + destination)).toEqual({
      origin: base,
      destination,
      locale,
      ingestionId,
      viewId,
    });
  },
);

it.each([
  { name: 'missing URL', base: origin, url: undefined },
  { name: 'missing base origin', base: undefined, url: target },
  { name: 'malformed base origin', base: 'not-an-origin', url: target },
  {
    name: 'remote origin',
    base: 'http://example.test',
    url: target.replace(origin, 'http://example.test'),
  },
  {
    name: 'HTTPS',
    base: 'https://127.0.0.1:3100',
    url: target.replace('http:', 'https:'),
  },
  {
    name: 'different port',
    base: origin,
    url: target.replace(':3100', ':3101'),
  },
  {
    name: 'different loopback host',
    base: origin,
    url: target.replace('127.0.0.1', 'localhost'),
  },
  {
    name: 'IPv6 outside this case boundary',
    base: 'http://[::1]:3100',
    url: target.replace('127.0.0.1', '[::1]'),
  },
  {
    name: 'userinfo',
    base: origin,
    url: target.replace(
      'http://',
      'http://synthetic-private:synthetic-secret@',
    ),
  },
  {
    name: 'empty userinfo',
    base: origin,
    url: target.replace('http://', 'http://@'),
  },
  { name: 'fragment', base: origin, url: target + '#synthetic-fragment' },
  { name: 'empty fragment', base: origin, url: target + '#' },
  { name: 'missing fixed view', base: origin, url: origin + path },
  {
    name: 'duplicate fixed view',
    base: origin,
    url: target + `&candidateView=${viewId}`,
  },
  {
    name: 'extra cursor',
    base: origin,
    url: target + '&after=synthetic-private-cursor',
  },
  {
    name: 'wrong route',
    base: origin,
    url: target.replace('/ingestions/', '/operations/'),
  },
  {
    name: 'invalid ingestion UUID',
    base: origin,
    url: target.replace(ingestionId, 'not-a-uuid'),
  },
  {
    name: 'invalid view UUID',
    base: origin,
    url: target.replace(viewId, 'not-a-uuid'),
  },
  {
    name: 'noncanonical UUID',
    base: origin,
    url: target.replace(ingestionId, ingestionId.toUpperCase()),
  },
  {
    name: 'encoded parameter name',
    base: origin,
    url: target.replace('candidateView', '%63andidateView'),
  },
])('rejects $name without authorizing or running a case', ({ base, url }) => {
  expect(() => readCandidateBackflowTarget(base, url)).toThrow(/not_run/);
});

it('keeps invalid-input diagnostics free of supplied private markers', () => {
  let message = '';
  try {
    readCandidateBackflowTarget(
      origin,
      target + '&after=synthetic-private-cursor',
    );
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  expect(message).toMatch(/not_run/);
  expect(message).not.toContain('synthetic-private-cursor');
  expect(message).not.toContain(ingestionId);
  expect(message).not.toContain(viewId);
});

it('accepts the sole list reporter before any live credential step', () => {
  expect(() => assertCandidateBackflowReporter([['list']])).not.toThrow();
});

it.each([
  { name: 'HTML', reporters: [['html']] },
  { name: 'JSON', reporters: [['json']] },
  { name: 'blob', reporters: [['blob']] },
  { name: 'custom', reporters: [['synthetic-custom-reporter']] },
  { name: 'mixed', reporters: [['list'], ['html']] },
  { name: 'missing', reporters: [] },
] satisfies { name: string; reporters: [string, unknown?][] }[])(
  'rejects $name reporter before any live credential step',
  ({ reporters }) => {
    expect(() => assertCandidateBackflowReporter(reporters)).toThrow(/not_run/);
  },
);
