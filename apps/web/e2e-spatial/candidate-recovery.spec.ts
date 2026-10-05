import { expect, test } from '@playwright/test';
import { getDictionary } from '../src/lib/i18n';

// Actual component in a task-owned, no-env Vite harness; HTTP replies are
// synthetic. These checks prove native inert interaction, not real Auth/SQL
// or an actual browser back/forward-cache restoration.
const fixture = process.env.WISER_CANDIDATE_RECOVERY_URL;
test.skip(!fixture, 'Requires the isolated actual-component recovery harness');
const reference = {
  kind: 'ingestion-candidate',
  ingestionId: '10000000-0000-4000-8000-000000000001',
  processingBatchId: '10000000-0000-4000-8000-000000000002',
  reviewHash: 'a'.repeat(64),
};
const assetId = '10000000-0000-4000-8000-000000000003';
const recordId = '10000000-0000-4000-8000-000000000004';
const rawValue = 'Synthetic permitted delivered bytes';
const assets = {
  reference,
  parserVersion: 'synthetic-browser-v1',
  status: 'READY',
  createdAt: '2026-10-03T00:00:00Z',
  totalAssetCount: 1,
  knownRecordCount: 1,
  knownFeatureCount: 1,
  unknownAssetCount: 0,
  assets: [
    {
      assetId,
      sourceHash: 'b'.repeat(64),
      status: 'READY',
      recordCount: 1,
      featureCount: 1,
      reason: null,
    },
  ],
  nextCursor: null,
};
const records = {
  reference,
  assetId,
  columns: [{ key: 'name', label: 'Original text' }],
  records: [
    {
      recordId,
      assetId,
      index: 2,
      sourceId: 'table:1/row:2',
      hasGeometry: true,
      values: { name: rawValue },
    },
  ],
  nextCursor: null,
};
for (const locale of ['zh-CN', 'en'] as const) {
  for (const width of [1440, 390]) {
    for (const theme of ['light', 'dark']) {
      test(`${locale} ${width}px ${theme}: native inert prevents new reads and navigation during both discrete recovery events`, async ({
        page,
        context,
      }, testInfo) => {
        const copy = getDictionary(locale).dataFoundation.candidateReader;
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        let held: (() => void) | undefined;
        let hold = false;
        let status = 200;
        const requests: string[] = [];
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (
            !['127.0.0.1', 'localhost'].includes(url.hostname) &&
            !['data:', 'blob:'].includes(url.protocol)
          ) {
            errors.push(`Unexpected external request: ${url.origin}`);
            return route.abort();
          }
          if (!url.pathname.startsWith('/api/data-foundation/candidates/'))
            return route.continue();
          requests.push(url.pathname);
          if (hold)
            await new Promise<void>((resolve) => {
              held = resolve;
            });
          if (status !== 200) return route.fulfill({ status, body: '' });
          const body = url.pathname.endsWith('/get') ? assets : records;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
          });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(`${fixture}?locale=${locale}&theme=${theme}`);
        await page
          .getByRole('button', { name: copy.readRecords, exact: true })
          .click();
        await expect(page.getByText(rawValue, { exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: copy.refresh, exact: true }),
        ).toBeEnabled();
        await page
          .getByRole('button', { name: `${copy.selectRecord} 2`, exact: true })
          .click();
        const original = page.getByRole('link', {
          name: copy.downloadOriginal,
          exact: true,
        });
        await expect(original).toBeVisible();
        const capture =
          (locale === 'zh-CN' && width === 390 && theme === 'dark') ||
          (locale === 'en' && width === 1440 && theme === 'light');
        if (capture)
          await page.screenshot({
            path: testInfo.outputPath('permitted-reading.png'),
            fullPage: true,
          });
        for (const event of ['visible', 'pageshow']) {
          await original.focus();
          const before = requests.length;
          hold = true;
          held = undefined;
          const syncGate = await page.evaluate((event) => {
            if (event === 'visible')
              document.dispatchEvent(new Event('visibilitychange'));
            else
              window.dispatchEvent(
                new PageTransitionEvent('pageshow', { persisted: true }),
              );
            const link = document.querySelector<HTMLAnchorElement>(
              'a[href*="candidate-assets"]',
            )!;
            const gated = link.closest('[inert]') !== null;
            link.focus();
            return {
              gated,
              focusInside: Boolean(document.activeElement?.closest('[inert]')),
            };
          }, event);
          expect(syncGate.gated).toBe(true);
          await expect.poll(() => requests.length).toBe(before + 1);
          await expect.poll(() => Boolean(held)).toBe(true);
          await expect(page.getByText(rawValue, { exact: true })).toBeVisible();
          if (capture && event === 'visible')
            await page.screenshot({
              path: testInfo.outputPath('recovery-inert.png'),
              fullPage: true,
            });
          const box = await original.boundingBox();
          expect(box).not.toBeNull();
          await page.mouse.click(
            box!.x + box!.width / 2,
            box!.y + box!.height / 2,
          );
          const recoveryUrl = page.url();
          for (let index = 0; index < 8; index++) {
            await page.keyboard.press('Tab');
            expect(
              await page.evaluate(() =>
                Boolean(document.activeElement?.closest('[inert]')),
              ),
            ).toBe(false);
          }
          // Force still uses native pointer dispatch: inert prevents this tab
          // from initiating a geometry read or navigating its original link.
          await page
            .getByRole('tab', { name: copy.map, exact: true })
            .click({ force: true });
          expect(requests.length).toBe(before + 1);
          expect(page.url()).toBe(recoveryUrl);
          status = event === 'pageshow' ? 403 : 200;
          hold = false;
          held!();
          if (status === 403) {
            await expect(page.getByRole('alert')).toBeVisible();
            await expect(page.getByText(rawValue, { exact: true })).toHaveCount(
              0,
            );
            await expect(original).toHaveCount(0);
          } else {
            await expect(
              page.getByRole('button', { name: copy.refresh, exact: true }),
            ).toBeEnabled();
            await expect(original).toBeVisible();
            await expect(page.locator('[inert]')).toHaveCount(0);
          }
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        expect(errors).toEqual([]);
      });
    }
  }
}
