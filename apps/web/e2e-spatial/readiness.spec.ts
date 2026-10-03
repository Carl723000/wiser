import { expect, test, type Page } from '@playwright/test';
import { getDictionary, type Locale } from '../src/lib/i18n';

const route = '/data-foundation/spatial-workspace';
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
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

async function openReadiness(page: Page, locale: Locale, region: string) {
  const dictionary = getDictionary(locale).dataFoundation;
  await page.goto(`/${locale}${route}`);
  await page
    .getByRole('tab', { name: dictionary.spatialManagement.readiness })
    .click();
  await page
    .getByRole('combobox', { name: dictionary.spatialManagement.selectRegion })
    .selectOption(region);
  return dictionary.spatialReadiness;
}
async function inspect(page: Page, label: string, action: string) {
  await page
    .getByRole('heading', { name: label, exact: true })
    .locator('..')
    .locator('..')
    .getByRole('button', { name: action, exact: true })
    .click();
  return page.getByRole('region', { name: label, exact: true });
}
async function count(page: Page, key: string, value: string) {
  await expect(page.locator(`[data-readiness-count="${key}"] dd`)).toHaveText(
    value,
  );
}

test('declared real coverage remains legible in both locales, themes and desktop/mobile viewports', async ({
  page,
}) => {
  for (const locale of ['zh-CN', 'en'] as const) {
    for (const width of [390, 1440]) {
      for (const theme of ['light', 'dark']) {
        await page.goto(`/${locale}${route}`);
        await page.evaluate(
          (value) => localStorage.setItem('wiser-theme', value),
          theme,
        );
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 1000,
        });
        const copy = await openReadiness(page, locale, 'chaobai');
        await count(page, 'records', '200');
        await count(page, 'namedObjects', '25');
        await count(page, 'monthlyRecords', '200');
        await count(page, 'validObservations', copy.unknown);
        await count(page, 'professionallyReviewed', '0');
        for (const label of [
          copy.questionLabels.cleaning,
          copy.questionLabels['quality-control'],
        ]) {
          const card = page
            .getByRole('heading', { name: label, exact: true })
            .locator('..')
            .locator('..');
          await expect(
            card.getByRole('button', { name: copy.inspect, exact: true }),
          ).toHaveCount(0);
          await expect(card).toContainText(copy.noDetails);
        }
        const detail = await inspect(
          page,
          copy.questionLabels.density,
          copy.inspect,
        );
        await expect(
          detail
            .getByRole('table', { name: copy.reportWindowsLabel })
            .getByRole('row'),
        ).toHaveCount(26);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
    }
  }
});

test('quantity inspection permits an explicit later-record choice and fixed source round trip', async ({
  page,
}) => {
  const copy = await openReadiness(page, 'zh-CN', 'chaobai');
  const detail = await inspect(
    page,
    copy.questionLabels.quantity,
    copy.inspect,
  );
  const records = detail.getByRole('group', { name: copy.grains.RECORD });
  await expect(records.getByRole('button')).toHaveCount(41);
  await records.getByRole('button').nth(1).click();
  const dossier = page.getByRole('region', { name: '对象证据档案' });
  await expect(dossier).toContainText('潮白河下段');
  await dossier.getByText('技术详情', { exact: true }).click();
  await expect(
    dossier.getByText('monthly-2023-04:t1:r15', { exact: true }),
  ).toBeVisible();
  const source = await page.context().newPage();
  await source.goto(
    (await dossier.getByRole('link').first().getAttribute('href'))!,
  );
  await expect(
    source.getByRole('heading', { name: '提取记录与原文定位' }),
  ).toBeVisible();
  await expect(source.locator('blockquote').first()).not.toBeEmpty();
  await source.close();
});

test('per-name gaps and pending correspondence preserve every real record and source identity', async ({
  page,
}) => {
  const copy = await openReadiness(page, 'zh-CN', 'beiyun');
  await count(page, 'records', '384');
  await count(page, 'namedObjects', '49');
  const detail = await inspect(page, copy.questionLabels.gaps, copy.inspect);
  const table = detail.getByRole('table', { name: copy.reportWindowsLabel });
  const expanded = detail;
  const more = expanded.getByRole('button', { name: new RegExp(copy.more) });
  if (await more.count()) await more.click();
  await expect(table.getByRole('row')).toHaveCount(50);
  const rawMissing = await table
    .locator('tbody tr td:nth-child(3)')
    .allTextContents();
  expect(rawMissing.some((value) => /2023-/.test(value))).toBe(true);
  await detail
    .getByRole('button', { name: copy.coverageModes.hypothetical, exact: true })
    .click();
  const nextMore = expanded.getByRole('button', {
    name: new RegExp(copy.more),
  });
  if (await nextMore.count()) await nextMore.click();
  await expect(table.getByRole('row')).toHaveCount(49);
  const association = table.getByRole('row').filter({ hasText: '↔' });
  await expect(association).toContainText('肖太后河');
  await expect(association).toContainText('萧太后河');
  await expect(association).toContainText(copy.none);
  await expect(detail.getByRole('status')).toHaveText(copy.hypotheticalNote);
  await count(page, 'records', '384');
  await count(page, 'namedObjects', '49');
  await count(page, 'professionallyReviewed', '0');
});

test('applied window, date role, pagination and keyboard focus do not reuse a stale result set', async ({
  page,
}) => {
  const copy = await openReadiness(page, 'zh-CN', 'chaobai');
  const scope = page.getByTestId('readiness-active-scope');
  await page.getByLabel(copy.startMonth).fill('2023-05');
  await page.getByLabel(copy.endMonth).fill('2023-06');
  await expect(scope).toContainText('2023-04 — 2023-11');
  await page
    .getByRole('button', { name: copy.applyWindow, exact: true })
    .click();
  await expect(scope).toContainText('2023-05 — 2023-06');
  await count(page, 'records', '200');
  const quantities = await inspect(
    page,
    copy.questionLabels.quantity,
    copy.inspect,
  );
  await expect(quantities).toBeFocused();
  const records = quantities.getByRole('group', { name: copy.grains.RECORD });
  await records.getByRole('button', { name: new RegExp(copy.more) }).click();
  await expect(records.getByRole('button')).toHaveCount(81);
  await page
    .getByLabel(copy.dateRole, { exact: true })
    .selectOption('OBSERVATION');
  await expect(quantities).toHaveCount(0);
  const density = await inspect(
    page,
    copy.questionLabels.density,
    copy.inspect,
  );
  const table = density.getByRole('table', { name: copy.reportWindowsLabel });
  const missing = await table
    .locator('tbody tr td:nth-child(3)')
    .allTextContents();
  expect(missing.every((value) => value === copy.unknown)).toBe(true);
  await page.getByLabel(copy.startMonth).fill('2023-11');
  await page.getByLabel(copy.endMonth).fill('2023-04');
  await page
    .getByRole('button', { name: copy.applyWindow, exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: copy.title }).getByRole('alert'),
  ).toHaveText(copy.windowError);
  await expect(scope).toContainText('2023-05 — 2023-06');
});
