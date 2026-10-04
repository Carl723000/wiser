// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot, type Root } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { AppShell } from './app-shell';

const navigation = vi.hoisted(() => ({
  pathname: '/zh-CN/data-foundation/spatial-workspace',
  search: 'track=REAL&pane=map',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock('next/link', () => ({
  default: (props: ComponentProps<'a'>) => <a {...props} />,
}));
vi.mock('./theme-toggle', () => ({
  ThemeToggle: () => <span data-testid="theme-placeholder" />,
}));

it.each([
  ['zh-CN', 'en'],
  ['en', 'zh-CN'],
] as const)(
  'hydrates the %s locale link after an early query change without dropping the current selection',
  async (locale, otherLocale) => {
    navigation.pathname = `/${locale}/data-foundation/spatial-workspace`;
    navigation.search = 'track=REAL&pane=map';
    const screen = () => (
      <AppShell locale={locale}>
        <main id="main-content">Reading</main>
      </AppShell>
    );
    const host = document.createElement('div');
    host.innerHTML = renderToString(screen());
    document.body.appendChild(host);
    expect(host.querySelector('a[hreflang]')).toBeNull();

    // A child may push fixed reading state before this shell boundary hydrates.
    navigation.search =
      'track=REAL&dayStart=2023-04-01&dayEnd=2023-04-17&pane=evidence';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root: Root | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(host, screen());
        await Promise.resolve();
      });
      expect(errors.mock.calls.flat().join(' ')).not.toMatch(
        /hydrated|hydration|didn't match/i,
      );
      const link = host.querySelector<HTMLAnchorElement>(
        `a[hreflang="${otherLocale}"]`,
      );
      expect(link?.getAttribute('href')).toBe(
        `/${otherLocale}/data-foundation/spatial-workspace?${navigation.search}`,
      );

      // Back/forward updates must continue to preserve the active query.
      navigation.search = 'track=REAL&pane=results';
      await act(async () => {
        root?.render(screen());
        await Promise.resolve();
      });
      expect(link?.getAttribute('href')).toBe(
        `/${otherLocale}/data-foundation/spatial-workspace?${navigation.search}`,
      );
    } finally {
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
      host.remove();
      errors.mockRestore();
    }
  },
);
