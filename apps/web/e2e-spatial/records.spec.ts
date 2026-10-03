import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { getDictionary } from '../src/lib/i18n';

const output = process.env.WISER_SPATIAL_ACCEPTANCE_DIRECTORY;
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, context }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  await context.route('**/*', async (request) => {
    const url = new URL(request.request().url());
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) &&
      !['blob:', 'data:'].includes(url.protocol)
    ) {
      errors.get(page)!.push(`Unexpected external request: ${url.origin}`);
      await request.abort();
    } else await request.continue();
  });
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

test('bounded original-field tables preserve later-page evidence, map camera and fullscreen across locales, themes and viewport sizes', async ({
  page,
}) => {
  for (const locale of ['zh-CN', 'en'] as const) {
    const copy = getDictionary(locale).dataFoundation.spatialWorkspace;
    const fullscreen = locale === 'zh-CN' ? '全屏工作区' : 'Expand workspace';
    for (const width of [390, 1440]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        await page.goto(`/${locale}/data-foundation/spatial-workspace`);
        await page.evaluate(
          (value) => localStorage.setItem('wiser-theme', value),
          theme,
        );
        await page.reload();
        const map = page.getByTestId('spatial-geographic-map');
        const camera = await map.getAttribute('data-camera');
        if (width === 390)
          await page
            .getByRole('tab', { name: copy.readingPanes.results, exact: true })
            .click();
        const region = page.getByRole('region', {
          name: copy.unlocatedTitle,
          exact: true,
        });
        const table = region.getByRole('table', { name: copy.unlocatedTitle });
        await expect(table.getByRole('row')).toHaveCount(41);
        for (const column of Object.values(copy.recordColumns))
          await expect(
            table.getByRole('columnheader', { name: column, exact: true }),
          ).toHaveCount(1);
        const frame = region.getByRole('region', { name: copy.recordScroll });
        expect(
          await frame.evaluate(
            (element) => element.clientHeight <= innerHeight * 0.61,
          ),
        ).toBe(true);
        expect(
          await frame.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        ).toBe(true);
        if (width === 390) {
          await frame.focus();
          await frame.press('ArrowRight');
          await expect
            .poll(() => frame.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
        }
        const initialPage = await region
          .getByRole('navigation', { name: copy.recordNavigation })
          .locator('p span')
          .innerText();
        const pages = Number(initialPage.match(/1\/(\d+)/)?.[1]);
        expect(pages).toBeGreaterThan(1);
        await region
          .getByRole('button', { name: copy.nextRecords, exact: true })
          .click();
        await expect(region).toContainText(
          copy.recordPage
            .replace('{page}', '2')
            .replace('{pages}', String(pages)),
        );
        const first = table.getByRole('row').nth(1).getByRole('button');
        const name = await first.innerText();
        await first.click();
        const dossier = page.getByRole('region', { name: copy.dossierTitle });
        await expect(
          dossier.getByRole('heading', { name, level: 3, exact: true }),
        ).toBeVisible();
        await expect(
          dossier.getByRole('link', { name: copy.openOriginal }),
        ).toHaveAttribute(
          'href',
          /\/spatial-workspace\/source\?source=.+&version=.+/,
        );
        await expect(map).toHaveAttribute('data-camera', camera!);
        if (width === 390)
          await page
            .getByRole('tab', { name: copy.readingPanes.results, exact: true })
            .click();
        await expect(first).toHaveAttribute('aria-pressed', 'true');
        const range = await region
          .getByRole('navigation', { name: copy.recordNavigation })
          .textContent();
        await region.evaluate((element) => {
          const panel = element.closest('[role=tabpanel]');
          if (panel) {
            panel.scrollTop +=
              element.getBoundingClientRect().top -
              panel.getBoundingClientRect().top;
            window.scrollTo({
              top: panel.getBoundingClientRect().top + scrollY - 140,
              behavior: 'instant',
            });
          } else
            window.scrollTo({
              top: element.getBoundingClientRect().top + scrollY - 120,
              behavior: 'instant',
            });
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (output)
          await page.screenshot({
            path: join(output, `${locale}-${theme}-records-${width}.png`),
          });
        await page
          .getByRole('button', { name: fullscreen, exact: true })
          .click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(first).toHaveAttribute('aria-pressed', 'true');
        await expect(
          region.getByRole('navigation', { name: copy.recordNavigation }),
        ).toHaveText(range!);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(first).toHaveAttribute('aria-pressed', 'true');
        await expect(map).toHaveAttribute('data-camera', camera!);
      }
    }
  }
});

test('filter changes reset record pages and no-data recovery preserves original scope and pending states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const copy = getDictionary('zh-CN').dataFoundation.spatialWorkspace;
  await page.goto('/zh-CN/data-foundation/spatial-workspace');
  await page
    .getByRole('tab', { name: copy.readingPanes.results, exact: true })
    .click();
  const region = page.getByRole('region', {
    name: copy.unlocatedTitle,
    exact: true,
  });
  await region
    .getByRole('button', { name: copy.nextRecords, exact: true })
    .click();
  const initialCount = await page
    .getByTestId('spatial-record-count')
    .textContent();
  const filter = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: copy.filters }) })
    .first();
  await filter.locator('summary').click();
  const search = page.getByLabel(copy.recordSearch, { exact: true });
  await search.fill('不存在的检索词-Goal101-真实空结果');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(
    page.getByText(copy.emptyRecords, { exact: true }),
  ).toBeVisible();
  await search.fill('');
  await expect(
    region.getByRole('button', { name: copy.previousRecords, exact: true }),
  ).toBeDisabled();
  await expect(page.getByTestId('spatial-record-count')).toHaveText(
    initialCount!,
  );
  await expect(region.getByRole('table')).toContainText(copy.pending);
  await filter.locator('summary').click();
  await page
    .getByRole('tab', { name: copy.readingPanes.results, exact: true })
    .click();
  await expect(region.getByRole('table').getByRole('row')).toHaveCount(41);
});
