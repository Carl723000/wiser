import { expect, test } from '@playwright/test';
import { getDictionary } from '../src/lib/i18n';

const regions = [
  'bth',
  'yongding',
  'chaobai',
  'beiyun',
  'daqing-baiyangdian',
  'bohai',
] as const;

for (const locale of ['zh-CN', 'en'] as const) {
  for (const mode of ['keyboard', 'scroll-and-focus'] as const) {
    test(`${locale} ${mode}: selected matrix text remains readable beside its frozen need column`, async ({
      page,
      context,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/*', async (request) => {
        const url = new URL(request.request().url());
        if (
          !['localhost', '127.0.0.1'].includes(url.hostname) &&
          !['blob:', 'data:'].includes(url.protocol)
        ) {
          errors.push(`Unexpected external request: ${url.origin}`);
          await request.abort();
        } else await request.continue();
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const copy = getDictionary(locale).dataFoundation;
      for (const theme of ['light', 'dark']) {
        await page.goto(`/${locale}/data-foundation/spatial-workspace`);
        await page.evaluate(
          (value) => localStorage.setItem('wiser-theme', value),
          theme,
        );
        await page.reload();
        await page
          .getByRole('tab', { name: copy.spatialManagement.readiness })
          .click();
        const matrix = page.getByRole('region', {
          name: copy.spatialReadiness.matrixTitle,
          exact: true,
        });
        await expect(matrix.locator('[data-matrix-region]')).toHaveCount(114);
        await expect(matrix.getByRole('rowheader')).toHaveCount(19);
        for (const [index, region] of regions.entries()) {
          const cell = matrix.locator(
            `[data-matrix-region="${region}"][data-matrix-need="K5-001"]`,
          );
          const before = await cell.locator('strong').textContent();
          if (mode === 'scroll-and-focus') {
            await cell.scrollIntoViewIfNeeded();
            await cell.focus();
          } else if (index === 0) await cell.focus();
          else await page.keyboard.press('Tab');
          await expect(cell).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(cell).toHaveAttribute('aria-pressed', 'true');
          await expect(cell.locator('strong')).toHaveText(before!);
          await expect
            .poll(async () =>
              cell.evaluate((element) => {
                const table = element.closest('table')!;
                const scroller = table.parentElement!;
                const fixed = element
                  .closest('tr')!
                  .querySelector('th[scope="row"]')!
                  .getBoundingClientRect();
                const container = scroller.getBoundingClientRect();
                const left = Math.max(
                  container.left + scroller.clientLeft,
                  fixed.right,
                );
                const right =
                  container.left + scroller.clientLeft + scroller.clientWidth;
                const targets = element.querySelectorAll(
                  'strong, span[data-state]',
                );
                const hidden: string[] = [];
                for (const target of targets) {
                  const walker = document.createTreeWalker(
                    target,
                    NodeFilter.SHOW_TEXT,
                  );
                  while (walker.nextNode()) {
                    if (!walker.currentNode.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(walker.currentNode);
                    for (const rectangle of range.getClientRects()) {
                      if (
                        rectangle.width > 0 &&
                        (rectangle.left < left - 0.5 ||
                          rectangle.right > right + 0.5)
                      )
                        hidden.push(walker.currentNode.textContent.trim());
                    }
                  }
                }
                return hidden;
              }),
            )
            .toEqual([]);
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      }
      expect(errors).toEqual([]);
    });
  }
}
