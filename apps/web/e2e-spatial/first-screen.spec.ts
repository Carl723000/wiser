import { expect, test } from '@playwright/test';

for (const locale of ['zh-CN', 'en'] as const)
  for (const theme of ['light', 'dark'] as const)
    for (const width of [1440, 390])
      test(`${locale} ${theme} ${width}px opens an operable map in the first screen`, async ({
        page,
      }) => {
        const height = width === 1440 ? 900 : 844;
        await page.setViewportSize({ width, height });
        await page.addInitScript(
          (value) => localStorage.setItem('wiser-theme', value),
          theme,
        );
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const response = await page.goto(
          `/${locale}/data-foundation/spatial-workspace`,
        );
        expect(response?.status()).toBe(200);
        const workspace = page.getByTestId('spatial-workspace');
        if (width === 390)
          await expect(
            workspace.getByRole('tab', {
              name: locale === 'zh-CN' ? '地图' : 'Map',
              exact: true,
            }),
          ).toHaveAttribute('aria-selected', 'true');
        const map = workspace.getByTestId('spatial-geographic-map').first();
        await expect(map).toBeVisible();
        // A fresh entry must fit without scrolling or opening fullscreen first.
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        const dimensions = await map.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const main = document.querySelector('#main-content')!;
          return {
            height: rect.height,
            visibleHeight: Math.max(
              0,
              Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
            ),
            widthRatio: rect.width / main.getBoundingClientRect().width,
            pageWidth: document.documentElement.scrollWidth,
          };
        });
        const minimum = width === 1440 ? 450 : 300;
        expect(dimensions.height).toBeGreaterThanOrEqual(minimum);
        expect(dimensions.visibleHeight).toBeGreaterThanOrEqual(minimum);
        if (width === 1440)
          expect(dimensions.widthRatio).toBeGreaterThanOrEqual(0.55);
        expect(dimensions.pageWidth).toBeLessThanOrEqual(width);
        expect(errors).toEqual([]);
      });
