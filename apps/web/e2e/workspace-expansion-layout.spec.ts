import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
const globals = readFileSync(
  new URL('../src/app/globals.css', import.meta.url),
  'utf8',
);
const workspace = readFileSync(
  new URL(
    '../src/components/exploration-workspace.module.css',
    import.meta.url,
  ),
  'utf8',
);
for (const width of [390, 1920])
  test(`expanded workspace fills viewport despite page-main at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // Both cascade orders can occur between global and split component styles.
    for (const css of [globals + workspace, workspace + globals]) {
      await page.setContent(
        `<style>${css}</style><main class="page-main expanded" role="dialog" aria-label="Exploration"><button>Return</button></main>`,
      );
      const rect = await page.getByRole('dialog').boundingBox();
      expect(rect?.x).toBe(0);
      expect(rect?.y).toBe(0);
      expect(rect?.width).toBe(width);
      expect(rect?.height).toBe(900);
    }
  });
