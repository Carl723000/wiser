import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { getDictionary } from '../src/lib/i18n';

const css = readFileSync(
  new URL(
    '../src/components/data-resource-content.module.css',
    import.meta.url,
  ),
  'utf8',
);
for (const locale of ['zh-CN', 'en'] as const)
  for (const width of [390, 1440])
    for (const theme of ['light', 'dark'])
      test(`nested table evidence stays readable ${locale}/${width}/${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const copy = getDictionary(locale).dataFoundation.content;
        const summary = copy.items.replace('{count}', '3');
        const object = (key: string, value: string) =>
          `<details class="object" open><summary>${summary}</summary><dl><div><dt>${key}</dt><dd>${value}</dd></div></dl></details>`;
        await page.setContent(
          `<style>${css}</style><main data-theme="${theme}" style="width:200px;font:16px sans-serif">${object('cells', object('2', object('text', '<span class="value">22.35 b</span>')))}</main>`,
        );
        const value = page.getByText('22.35 b', { exact: true });
        await expect(value).toBeVisible();
        // A short source number must remain one readable line even inside
        // a narrow table cell on a wide desktop viewport.
        expect(
          await value.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getClientRects().length;
          }),
        ).toBe(1);
        expect(
          await page
            .locator('main')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await page.locator('summary').first().focus();
        await page.keyboard.press('Enter');
        await expect(value).toBeHidden();
        await page.keyboard.press('Enter');
        await expect(value).toBeVisible();
      });
