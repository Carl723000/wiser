import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('fixed real pack warm filtering, selection and camera latency', async ({
  page,
  context,
}) => {
  await context.route('**/*', async (request) => {
    const url = new URL(request.request().url());
    if (url.hostname !== '127.0.0.1' && url.protocol !== 'blob:')
      throw new Error(`Unexpected external request: ${url.origin}`);
    await request.continue();
  });
  const openedAt = performance.now();
  await page.goto('/zh-CN/data-foundation/spatial-workspace');
  const map = page.getByTestId('spatial-geographic-map');
  await expect(map).toHaveAttribute('data-renderer', 'maplibre');
  await expect(map.locator('canvas')).toBeVisible();
  const firstOpenMs = performance.now() - openedAt;
  const counts = await page.getByTestId('spatial-record-count').textContent();
  const renderer = await map.locator('canvas').evaluate((canvas) => {
    const gl =
      (canvas as HTMLCanvasElement).getContext('webgl2') ??
      (canvas as HTMLCanvasElement).getContext('webgl');
    if (!gl) return { renderer: 'unavailable' };
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: String(
        extension
          ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
      ),
      vendor: String(
        extension
          ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
      ),
      version: String(gl.getParameter(gl.VERSION)),
    };
  });
  const filter = page.getByRole('checkbox', { name: '监测', exact: true });
  const selection = page
    .getByRole('region', { name: '区域资料清单' })
    .getByRole('table')
    .getByRole('button');
  const camera = page.getByRole('button', { name: '向右旋转', exact: true });
  const samples: Record<string, number[]> = {
    filter: [],
    selection: [],
    camera: [],
  };
  for (let round = 0; round < 21; round++) {
    const elapsed = await filter.evaluate(async (element) => {
      const before = document.querySelector(
        '[data-testid="spatial-record-count"]',
      )?.textContent;
      const began = performance.now();
      (element as HTMLElement).click();
      while (
        document.querySelector('[data-testid="spatial-record-count"]')
          ?.textContent === before
      )
        await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return performance.now() - began;
    });
    if (round > 0) samples.filter.push(elapsed);
  }
  // Twenty-one toggles end with the monitoring layer off. Restore it before selection.
  await filter.check();
  for (let round = 0; round < 21; round++) {
    const elapsed = await selection.nth(round % 2).evaluate(async (element) => {
      const began = performance.now();
      (element as HTMLElement).click();
      while (element.getAttribute('aria-pressed') !== 'true')
        await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return performance.now() - began;
    });
    if (round > 0) samples.selection.push(elapsed);
  }
  for (let round = 0; round < 21; round++) {
    const elapsed = await camera.evaluate(async (element) => {
      const mapElement = document.querySelector(
        '[data-testid="spatial-geographic-map"]',
      );
      const before = mapElement?.getAttribute('data-camera');
      const began = performance.now();
      (element as HTMLElement).click();
      while (mapElement?.getAttribute('data-camera') === before)
        await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return performance.now() - began;
    });
    if (round > 0) samples.camera.push(elapsed);
  }
  const summary = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        key,
        {
          repeats: values.length,
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    }),
  );
  const output = process.env.WISER_SPATIAL_ACCEPTANCE_DIRECTORY;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, 'performance.json'),
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          browser: context.browser()?.version(),
          viewport: page.viewportSize(),
          renderer,
          counts,
          firstOpenMs,
          samples,
          summary,
          method:
            'In-page click to changed rendered state plus one animation frame; first repeat discarded. First-open time includes navigation and does not imply a cold compile.',
          limitation:
            'One Chromium runtime on the local Mac. Renderer identity is recorded; no hardware GPU speed, FPS or other-device claim.',
        },
        null,
        2,
      ),
    );
  }
  expect(summary.filter.median).toBeLessThanOrEqual(150);
  expect(summary.filter.p95).toBeLessThanOrEqual(300);
  expect(summary.selection.median).toBeLessThanOrEqual(150);
  expect(summary.selection.p95).toBeLessThanOrEqual(300);
  expect(summary.camera.median).toBeLessThanOrEqual(200);
  expect(summary.camera.p95).toBeLessThanOrEqual(400);
});
