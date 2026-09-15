import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { getDictionary } from '../src/lib/i18n';
const css = readFileSync(
  new URL('../src/components/data-explorer.module.css', import.meta.url),
  'utf8',
).replace(/:global\(([^)]+)\)/g, '$1');
for (const locale of ['zh-CN', 'en'] as const)
  for (const width of [390, 1440])
    for (const failed of [false, true])
      test(`map note leaves controls visible ${locale}/${width}/${failed}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const note = getDictionary(locale).dataFoundation.amap.positionLimit;
        await page.setContent(
          `<style>${css}</style><section style="position:relative"><div class="mapCanvas">${failed ? `<div class="mapNotice" role="status"><button>Retry</button></div>` : '<details class="mapLegend" open><summary>Layers</summary><fieldset><label><input type="checkbox">Vector features</label><label><input type="checkbox">Raster</label></fieldset></details>'}</div><p class="mapPositionNote" role="note">${note}</p></section>`,
        );
        const control = page.locator(failed ? '.mapNotice' : '.mapLegend');
        const a = await control.boundingBox(),
          b = await page.getByRole('note').boundingBox();
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(
          Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y),
        ).toBeLessThanOrEqual(0);
        await expect(
          control.locator(failed ? 'button' : 'summary'),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      });
