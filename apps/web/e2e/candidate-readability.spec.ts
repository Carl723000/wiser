import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { getDictionary, type Locale } from '../src/lib/i18n';

// Synthetic CSS-layout regression only. This reproduces the relevant JSX
// hierarchy, not authentication, React state, API access, or phone hardware.
// Prefix local selectors as CSS Modules do: shell and reader both use names
// such as "header" and "actions", which must not collide in this fixture.
const moduleCss = (file: string, prefix: string) =>
  readFileSync(new URL(file, import.meta.url), 'utf8').replace(
    /\.([A-Za-z_][A-Za-z0-9_-]*)/g,
    `.${prefix}$1`,
  );
const globals = readFileSync(
  new URL('../src/app/globals.css', import.meta.url),
  'utf8',
).replace(/^@import\s+['"]tailwindcss['"];\s*/m, '');
// The real global import includes Tailwind's base reset. Read the admitted
// dependency's actual stylesheet instead of relying on browser default styles.
const require = createRequire(import.meta.url);
const tailwindRequire = createRequire(require.resolve('@tailwindcss/postcss'));
const preflight = readFileSync(
  join(dirname(tailwindRequire.resolve('tailwindcss')), '../preflight.css'),
  'utf8',
);
const css = [
  `@layer theme, base, components, utilities; @layer base { ${preflight} }`,
  globals,
  moduleCss('../src/components/app-shell.module.css', 'shell-'),
  moduleCss(
    '../src/components/ingestion-candidate-reader.module.css',
    'reader-',
  ),
].join('\n');

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });

function shell(locale: Locale, theme: 'light' | 'dark', child: string) {
  const copy = getDictionary(locale);
  const e = escapeHtml;
  const link = (className: string, href: string, label: string) =>
    `<a class="shell-${className}" href="/${locale}${href}">${e(label)}</a>`;
  // AppShell + CurrentUserControl's existing authenticated, non-project-access
  // branch. Feature flags and access checks are not altered by this fixture.
  return `<!doctype html><html lang="${locale}" data-theme="${theme}">
    <head><style>${css}</style></head><body><div class="shell-shell">
    <a class="shell-skip" href="#main-content">${e(copy.shell.skip)}</a>
    <header class="shell-header">
      <a class="shell-brand" href="/${locale}">
        <svg class="shell-mark" viewBox="0 0 52 52" aria-hidden="true">
          <path d="M5 30c8 0 9-12 18-12s9 12 18 12c3 0 5-1 7-4" />
          <path class="shell-bank" d="M8 39h36" />
          <circle cx="23" cy="18" r="3.5" />
        </svg>
        <span><strong>${e(copy.brand.name)}</strong><small>${e(copy.brand.product)}</small></span>
      </a>
      <nav class="shell-systemNav" aria-label="${e(copy.systems.navigation)}">
        ${link('system-link', '/data-foundation', copy.systems.dataFoundation)}
        ${link('system-link', '/scenarios', copy.systems.agentExcon)}
      </nav>
      <div class="shell-actions">
        <div class="shell-authControl">
          <span class="shell-authState" data-state="authenticated"
            aria-label="${e(copy.auth.signedIn)}: synthetic-reader@example.test"
            title="synthetic-reader@example.test">
            <span class="shell-authStateMark" aria-hidden="true"></span>
            <span class="shell-authStateLabel">synthetic-reader@example.test</span>
          </span>
          ${link('authAction', '/account/password', copy.auth.ownPassword.title)}
          ${link('authAction', '/account/agents', copy.auth.agentConnections.title)}
          <form action="/${locale}/auth/sign-out" method="post">
            <button class="shell-authAction" type="submit">${e(copy.auth.signOut)}</button>
          </form>
        </div>
        <button class="shell-themeToggle" type="button" data-theme="${theme}"
          aria-pressed="${theme === 'dark'}"
          aria-label="${e(theme === 'dark' ? copy.shell.themeToLight : copy.shell.themeToDark)}">
          <span class="shell-themeTrack" aria-hidden="true">
            <span class="shell-themeOption" data-option="light"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.25" /></svg></span>
            <span class="shell-themeOption" data-option="dark"><svg viewBox="0 0 24 24"><path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z" /></svg></span>
            <span class="shell-themeThumb"></span>
          </span>
          <span class="shell-themeLabel">${e(copy.shell.theme)}</span>
        </button>
        <a class="shell-language" href="/${locale === 'zh-CN' ? 'en' : 'zh-CN'}/data-foundation/ingestions/synthetic-task"
          aria-label="${e(copy.shell.language)}：${e(copy.shell.otherLanguage)}">${e(copy.shell.otherLanguage)}</a>
      </div>
    </header>
    <main class="page-main" id="main-content">${child}</main>
    </div></body></html>`;
}

async function expectFullyAccessible(locator: Locator) {
  await expect(locator).toBeVisible();
  const observation = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    let clipLeft = 0,
      clipRight = innerWidth,
      clipTop = 0,
      clipBottom = innerHeight;
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
        clipLeft = Math.max(clipLeft, bounds.left);
        clipRight = Math.min(clipRight, bounds.right);
      }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
        clipTop = Math.max(clipTop, bounds.top);
        clipBottom = Math.min(clipBottom, bounds.bottom);
      }
    }
    // Rounded corners and transparent logo-box corners are not separate
    // actions. Test the control center and its actual visible text/icon centers.
    const points: [number, number][] = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const text of range.getClientRects()) {
        if (text.width > 0 && text.height > 0)
          points.push([text.left + text.width / 2, text.top + text.height / 2]);
      }
    }
    for (const icon of element.querySelectorAll('svg')) {
      const bounds = icon.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0)
        points.push([
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        ]);
    }
    return {
      description:
        element.getAttribute('aria-label') ||
        element.textContent?.trim() ||
        element.tagName,
      bounds: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      },
      clip: {
        left: clipLeft,
        right: clipRight,
        top: clipTop,
        bottom: clipBottom,
      },
      hit: points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || (hit !== null && element.contains(hit));
      }),
      hitDetails: points.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          tag: hit?.tagName,
          classes: hit?.getAttribute('class'),
          text: hit?.textContent?.trim().slice(0, 90),
        };
      }),
    };
  });
  // One CSS-pixel tolerance permits subpixel rounding, not clipped controls.
  expect
    .soft(observation.bounds.left)
    .toBeGreaterThanOrEqual(observation.clip.left - 1);
  expect
    .soft(observation.bounds.right)
    .toBeLessThanOrEqual(observation.clip.right + 1);
  expect
    .soft(observation.bounds.top)
    .toBeGreaterThanOrEqual(observation.clip.top - 1);
  expect
    .soft(observation.bounds.bottom)
    .toBeLessThanOrEqual(observation.clip.bottom + 1);
  expect
    .soft(
      observation.hit,
      `all hit-test points belong to ${observation.description}: ${JSON.stringify(observation.hitDetails)}`,
    )
    .toBe(true);
}

async function expectOneLine(locator: Locator) {
  await expect(locator).toBeVisible();
  const lineCount = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length;
  });
  expect
    .soft(
      lineCount,
      `short source text remains one readable line: ${await locator.innerText()}`,
    )
    .toBe(1);
}

async function readableTextObservation(locator: Locator) {
  return locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rectangles = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    let left = 0,
      right = innerWidth,
      top = 0,
      bottom = innerHeight;
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
        left = Math.max(left, rect.left + parent.clientLeft);
        right = Math.min(
          right,
          rect.left + parent.clientLeft + parent.clientWidth,
        );
      }
      if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
        top = Math.max(top, rect.top + parent.clientTop);
        bottom = Math.min(
          bottom,
          rect.top + parent.clientTop + parent.clientHeight,
        );
      }
    }
    return {
      readable:
        rectangles.length > 0 &&
        rectangles.every(
          (rect) =>
            rect.left >= left - 1 &&
            rect.right <= right + 1 &&
            rect.top >= top - 1 &&
            rect.bottom <= bottom + 1,
        ),
      hit:
        rectangles.length > 0 &&
        rectangles.every((rect) => {
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit === element || (hit !== null && element.contains(hit));
        }),
    };
  });
}

async function expectNoOuterHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      document: document.documentElement.scrollWidth <= innerWidth,
      body: document.body.scrollWidth <= innerWidth,
      scroll: scrollX,
    })),
  ).toEqual({ document: true, body: true, scroll: 0 });
}

for (const locale of ['zh-CN', 'en'] as const)
  for (const width of [390, 1440])
    for (const theme of ['light', 'dark'] as const) {
      test(`inline authorized shell controls stay readable and keyboard reachable ${locale}/${width}/${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.route('**/*', (route) => route.abort('blockedbyclient'));
        await page.setContent(shell(locale, theme, ''));
        const copy = getDictionary(locale);
        const header = page.locator('header');
        const controls = [
          header.locator('a.shell-brand'),
          header.getByRole('link', {
            name: copy.systems.dataFoundation,
            exact: true,
          }),
          header.getByRole('link', {
            name: copy.systems.agentExcon,
            exact: true,
          }),
          header.getByRole('link', {
            name: copy.auth.ownPassword.title,
            exact: true,
          }),
          header.getByRole('link', {
            name: copy.auth.agentConnections.title,
            exact: true,
          }),
          header.getByRole('button', { name: copy.auth.signOut, exact: true }),
          header.getByRole('button', {
            name:
              theme === 'dark'
                ? copy.shell.themeToLight
                : copy.shell.themeToDark,
            exact: true,
          }),
          header.getByRole('link', {
            name: `${copy.shell.language}：${copy.shell.otherLanguage}`,
            exact: true,
          }),
        ];
        for (const control of controls) await expectFullyAccessible(control);
        await expectFullyAccessible(header.locator('.shell-authState'));
        await expectOneLine(header.locator('.shell-brand strong'));
        await expectNoOuterHorizontalOverflow(page);

        await page
          .getByRole('link', { name: copy.shell.skip, exact: true })
          .focus();
        for (const control of controls) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expectFullyAccessible(control);
          expect
            .soft(
              await control.evaluate((element) => {
                const style = getComputedStyle(element);
                return (
                  element.matches(':focus-visible') &&
                  style.outlineStyle !== 'none' &&
                  parseFloat(style.outlineWidth) > 0
                );
              }),
              'keyboard focus has a visible outline',
            )
            .toBe(true);
        }
        await expect(controls[3]).toHaveAttribute(
          'href',
          `/${locale}/account/password`,
        );
        await expect(controls[4]).toHaveAttribute(
          'href',
          `/${locale}/account/agents`,
        );
        await expect(header.locator('form')).toHaveAttribute(
          'action',
          `/${locale}/auth/sign-out`,
        );
      });

      test(`candidate multi-column source values scroll inside their panel ${locale}/${width}/${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.route('**/*', (route) => route.abort('blockedbyclient'));
        const copy = getDictionary(locale).dataFoundation.candidateReader;
        const sourceLocator =
          'sheet:synthetic_evidence/row:2/column:original_source;' +
          'fixed-synthetic-reference-without-credentials-'.repeat(12);
        const e = escapeHtml;
        // Relevant Records panel hierarchy from IngestionCandidateReader.
        // Data values and row identity are explicit synthetic layout fixtures.
        await page.setContent(
          shell(
            locale,
            theme,
            `
          <section class="reader-reader" aria-label="${e(copy.title)}">
            <div class="reader-content">
              <section class="reader-tabPanel" role="tabpanel" aria-label="${e(copy.readRecords)}">
                <div class="reader-tableWrap" tabindex="0">
                  <table><thead><tr>
                    <th>${e(copy.row)}</th><th>report_month</th><th>value</th>
                    <th>location</th><th>provider</th><th>${e(copy.locator)}</th>
                  </tr></thead><tbody>
                    <tr data-selected="true" data-record-id="synthetic-record-2">
                      <th><button type="button" aria-pressed="true" aria-label="${e(copy.selectRecord)} 2">2</button></th>
                      <td>2026-01</td><td>22.35</td><td>synthetic-reach</td>
                      <td>synthetic-provider</td><td>${e(sourceLocator)}</td>
                    </tr>
                  </tbody></table>
                </div>
              </section>
            </div>
          </section>`,
          ),
        );
        const panel = page.getByRole('tabpanel');
        const wrap = panel.locator('.reader-tableWrap');
        const selected = panel.locator('tbody tr[data-selected="true"]');
        const identityBefore = await selected.getAttribute('data-record-id');
        const cellsBefore = await selected.locator('td').allTextContents();
        const pressBefore = await selected
          .getByRole('button')
          .getAttribute('aria-pressed');
        await expectOneLine(
          panel.getByRole('columnheader', {
            name: 'report_month',
            exact: true,
          }),
        );
        await expectOneLine(
          panel.getByRole('columnheader', { name: 'value', exact: true }),
        );
        await expectOneLine(
          selected.getByRole('cell', { name: '22.35', exact: true }),
        );
        const longReference = selected.getByRole('cell', {
          name: sourceLocator,
          exact: true,
        });
        expect
          .soft(
            await longReference.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getClientRects().length;
            }),
            'long original reference can wrap instead of widening the page',
          )
          .toBeGreaterThan(1);
        await expectNoOuterHorizontalOverflow(page);

        await selected.getByRole('button').focus();
        await page.keyboard.press('Shift+Tab');
        await expect(wrap).toBeFocused();
        const finalHeader = panel.getByRole('columnheader', {
          name: copy.locator,
          exact: true,
        });
        const dimensions = await wrap.evaluate((element) => ({
          width: element.clientWidth,
          full: element.scrollWidth,
        }));
        if (dimensions.full > dimensions.width) {
          await page.keyboard.press('ArrowRight');
          await expect
            .poll(() => wrap.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
          for (let step = 0; step < 120; step += 1) {
            if ((await readableTextObservation(finalHeader)).readable) break;
            const atEnd = await wrap.evaluate(
              (element) =>
                element.scrollLeft + element.clientWidth >=
                element.scrollWidth - 1,
            );
            if (atEnd) break;
            await page.keyboard.press('ArrowRight');
            await page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                ),
            );
          }
        }
        // At wide widths a table may fit; narrow widths must offer readable
        // text and reach the final field, irrespective of the chosen CSS widths.
        // The complete long-reference cell can be wider than the panel. Check
        // its actual heading text, not an impossible whole-cell bounding box.
        await expect
          .poll(() => readableTextObservation(finalHeader))
          .toEqual({
            readable: true,
            hit: true,
          });
        await expect(wrap).toBeFocused();
        expect
          .soft(
            await wrap.evaluate((element) => {
              const style = getComputedStyle(element);
              return (
                element.matches(':focus-visible') &&
                style.outlineStyle !== 'none' &&
                parseFloat(style.outlineWidth) > 0
              );
            }),
            'internal table scrolling retains visible keyboard focus',
          )
          .toBe(true);
        expect(await selected.getAttribute('data-record-id')).toBe(
          identityBefore,
        );
        expect(await selected.locator('td').allTextContents()).toEqual(
          cellsBefore,
        );
        expect(
          await selected.getByRole('button').getAttribute('aria-pressed'),
        ).toBe(pressBefore);
        await expect(selected.getByRole('button')).toHaveText('2');
        await expectNoOuterHorizontalOverflow(page);
      });

      test(`candidate field names retain readable words with larger fixture text ${locale}/${width}/${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.route('**/*', (route) => route.abort('blockedbyclient'));
        // A synthetic text-size stress case, not an OS-font or phone claim.
        // Preserve the real cell rules; exercise intrinsic column sizing when
        // the same source field needs more room than the default minimum.
        await page.setContent(
          shell(
            locale,
            theme,
            `<section class="reader-reader"><div class="reader-tableWrap" tabindex="0">
              <table style="font-size: 1.1rem"><thead><tr>
                <th>row</th><th>report_month</th><th>value</th><th>location</th><th>provider</th><th>source</th>
              </tr></thead><tbody><tr><th>2</th><td>2026-01</td><td>22.35</td><td>synthetic-reach</td><td>synthetic-provider</td><td>synthetic-source</td></tr></tbody></table>
            </div></section>`,
          ),
        );
        await expectOneLine(
          page.getByRole('columnheader', { name: 'report_month', exact: true }),
        );
        await expectOneLine(
          page.getByRole('cell', { name: '22.35', exact: true }),
        );
        await expectNoOuterHorizontalOverflow(page);
      });

      test(`candidate long unbroken field names wrap within their column ${locale}/${width}/${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.route('**/*', (route) => route.abort('blockedbyclient'));
        const field = 'synthetic_original_reference_field_'.repeat(14);
        await page.setContent(
          shell(
            locale,
            theme,
            `<section class="reader-reader"><div class="reader-tableWrap" tabindex="0">
              <table><thead><tr><th>row</th><th>${field}</th><th>value</th></tr></thead>
                <tbody><tr><th>2</th><td>synthetic-source</td><td>22.35</td></tr></tbody></table>
            </div></section>`,
          ),
        );
        const header = page.getByRole('columnheader', {
          name: field,
          exact: true,
        });
        const reading = await header.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const rectangles = [...range.getClientRects()];
          return {
            lines: rectangles.length,
            allTextInsideColumn: rectangles.every(
              (rect) =>
                rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
            ),
          };
        });
        expect(reading.lines).toBeGreaterThan(1);
        expect(reading.allTextInsideColumn).toBe(true);
        await expect(header).toHaveText(field);
        await expectNoOuterHorizontalOverflow(page);
      });
    }
