import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const route = '/zh-CN/data-foundation/spatial-workspace';
const output = process.env.WISER_SPATIAL_ACCEPTANCE_DIRECTORY;
const browserErrors = new WeakMap<BrowserContext, string[]>();
const browserWarnings = new WeakMap<BrowserContext, string[]>();
test.beforeEach(async ({ context }) => {
  const errors: string[] = [];
  const warnings: string[] = [];
  browserErrors.set(context, errors);
  browserWarnings.set(context, warnings);
  const observe = (page: Page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
      if (message.type() === 'warning') warnings.push(message.text());
    });
  };
  context.pages().forEach(observe);
  context.on('page', observe);
  await context.route('**/*', async (request) => {
    const url = new URL(request.request().url());
    if (url.hostname !== '127.0.0.1' && url.protocol !== 'blob:')
      throw new Error(
        `External browser request is not authorized: ${url.origin}`,
      );
    await request.continue();
  });
});
test.afterEach(async ({ context }, testInfo) => {
  const errors = browserErrors.get(context) ?? [];
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(
      join(output, `console-${testInfo.testId}.json`),
      JSON.stringify(
        {
          test: testInfo.title,
          errors,
          warnings: browserWarnings.get(context) ?? [],
        },
        null,
        2,
      ),
    );
  }
  expect(errors).toEqual([]);
});
test('actual regional matrix, fixed evidence, map camera, linked comparison, save and independent review', async ({
  page,
}) => {
  const errors = browserErrors.get(page.context()) ?? [];
  await page.goto(route);
  await expect(page.getByTestId('spatial-workspace')).toBeVisible();
  if (output)
    await page.screenshot({
      path: join(output, 'workspace-overview.png'),
      fullPage: true,
    });
  const beforeCount = await page
    .getByTestId('spatial-record-count')
    .textContent();
  await page.getByRole('tab', { name: '资料就绪与复核' }).click();
  await page
    .getByRole('combobox', { name: /浏览范围/ })
    .selectOption('chaobai');
  const row = page.locator('tr').filter({ hasText: 'K5-001' });
  await row.getByRole('button').first().click();
  const dossier = page.getByRole('region', { name: '对象证据档案' });
  await expect(page.getByRole('tab', { name: '空间与证据' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dossier).toBeVisible();
  await expect(page.getByTestId('spatial-original-evidence')).toContainText(
    'table',
  );
  const href = await dossier.getByRole('link').first().getAttribute('href');
  expect(href).toContain('/spatial-workspace/source?');
  const sourcePage = await page.context().newPage();
  await sourcePage.goto(href!);
  await expect(
    sourcePage.getByRole('heading', { name: '提取记录与原文定位' }),
  ).toBeVisible();
  await expect(sourcePage.locator('blockquote').first()).not.toBeEmpty();
  await sourcePage.close();
  const map = page.getByTestId('spatial-geographic-map');
  await expect(map).toHaveAttribute('data-renderer', 'maplibre');
  await page.getByRole('button', { name: '切换鸟瞰视图', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          JSON.parse((await map.getAttribute('data-camera')) ?? '{}') as {
            pitch?: number;
          }
        ).pitch,
    )
    .toBe(50);
  await page.getByRole('button', { name: '向右旋转', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          JSON.parse((await map.getAttribute('data-camera')) ?? '{}') as {
            bearing?: number;
          }
        ).bearing,
    )
    .not.toBe(0);
  const projection = await page
    .locator('[data-ground-anchor-error]')
    .evaluateAll((elements) =>
      elements.map((element) =>
        Number(element.getAttribute('data-ground-anchor-error')),
      ),
    );
  expect(projection.length).toBeGreaterThan(0);
  expect(Math.max(...projection)).toBeLessThanOrEqual(2);
  if (output)
    await page.screenshot({
      path: join(output, 'chaobai-3d-dossier.png'),
      fullPage: true,
    });
  await page
    .getByRole('checkbox', { name: '区域与时期对照', exact: true })
    .check();
  await expect(page.getByTestId('spatial-geographic-map')).toHaveCount(2);
  if (output)
    await page.screenshot({
      path: join(output, 'linked-comparison.png'),
      fullPage: true,
    });
  await page
    .getByRole('checkbox', { name: '区域与时期对照', exact: true })
    .uncheck();
  await page.getByLabel('场景名称').fill('潮白河查阅回归');
  await page.getByRole('button', { name: '保存当前场景', exact: true }).click();
  await page
    .getByRole('navigation', { name: '浏览范围' })
    .getByRole('button', { name: '北运河流域', exact: true })
    .click();
  await page.getByRole('button', { name: '恢复场景', exact: true }).click();
  await expect(dossier).toBeVisible();
  await page.getByRole('button', { name: '全屏工作区', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '开始合成演练', exact: true }).click();
  await page.getByLabel('核对理由').fill('仅演练候选位置排除及版本影响传播');
  await page.getByRole('button', { name: '保存本地决定', exact: true }).click();
  await page.getByRole('button', { name: '重新生成候选', exact: true }).click();
  await expect(
    page.getByRole('status', { name: '合成演练依赖预览' }),
  ).toBeVisible();
  const realSaved = await page.evaluate(() =>
    localStorage.getItem('wiser:goal100:spatial-scene:v1'),
  );
  const practiceView = page.getByTestId('exercise-workspace-view');
  await practiceView.getByLabel('场景名称').fill('合成演练隔离回归');
  await practiceView
    .getByRole('button', { name: '保存当前场景', exact: true })
    .click();
  await practiceView
    .getByRole('button', { name: '恢复场景', exact: true })
    .click();
  await page.getByRole('tab', { name: '资料就绪与复核' }).click();
  await expect(page.getByText(/受影响记录需重新核对/).first()).toBeVisible();
  await page
    .getByRole('button', { name: '结束演练并返回资料', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: '合成演练依赖预览' }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem('wiser:goal100:spatial-scene:v1'),
    ),
  ).toBe(realSaved);
  await page.getByRole('tab', { name: '空间与证据' }).click();
  await expect(page.getByTestId('spatial-original-evidence')).toContainText(
    'table',
  );
  await page.getByRole('tab', { name: '遥感检查' }).click();
  await expect(page.locator('#spatial-panel-raster img')).toHaveCount(4);
  await page.getByLabel('预检像元').selectOption('native-r323-c270');
  await expect(page.getByTestId('pixel-values')).toContainText('1857');
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'raster.png'), fullPage: true });
    await writeFile(
      join(output, 'workflow.json'),
      JSON.stringify(
        {
          errors,
          beforeCount,
          projection,
          sourceHref: href,
          browser: page.context().browser()?.version(),
        },
        null,
        2,
      ),
    );
  }
  expect(errors).toEqual([]);
});
test('two non-Yongding record/reference/source chains, time and spatial counterexamples, three real topics', async ({
  page,
}) => {
  for (const [id, object, reference] of [
    ['monthly-2023-04:t1:r14', '潮白河上段', '密云'],
    ['monthly-2023-04:t1:r38', '北运河', '通州'],
  ]) {
    await page.goto(`${route}?record=${encodeURIComponent(id)}`);
    const dossier = page.getByRole('region', { name: '对象证据档案' });
    await expect(dossier).toContainText(object);
    await expect(dossier).toContainText('table:1/row:');
    await expect(dossier).toContainText(reference);
    await expect(dossier).toContainText('参考范围，不能代替精确位置');
    await dossier
      .getByRole('button', { name: '查看此位置', exact: true })
      .click();
    await expect(
      dossier.getByRole('button', { name: '查看此位置', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const fixed = await dossier.getByRole('link').first().getAttribute('href');
    const wrong = new URL(fixed!, 'http://127.0.0.1:3410');
    wrong.searchParams.set('version', 'missing-fixed-version');
    const response = await page.request.get(wrong.href);
    expect(response.status()).toBe(404);
  }
  await page.getByLabel('起始日期', { exact: true }).fill('2023-04-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2023-04-30');
  await expect(
    page.getByRole('region', { name: '对象证据档案' }),
  ).toContainText('2023-04');
  await page.getByLabel('起始日期', { exact: true }).fill('2026-04-01');
  await page.getByLabel('保留时间未知资料', { exact: true }).uncheck();
  await expect(
    page.getByTestId('spatial-workspace').getByRole('alert'),
  ).toContainText('开始时间不晚于结束时间');
  await page.getByRole('button', { name: '重置资料筛选', exact: true }).click();
  await page.getByLabel('矩形范围', { exact: true }).fill('119,35,118,40');
  await page.getByRole('button', { name: '应用矩形范围', exact: true }).click();
  await expect(
    page.getByTestId('spatial-workspace').getByRole('alert'),
  ).toContainText('范围格式不正确');
  await page.getByLabel('矩形范围', { exact: true }).fill('119,35,120,36');
  await page.getByRole('button', { name: '应用矩形范围', exact: true }).click();
  await expect(
    page.getByText(/已定位资料在当前矩形范围外/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '位置未确定资料' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '重置资料筛选', exact: true }).click();
  const topics = page
    .getByRole('region', { name: '专题证据包' })
    .locator('details');
  await expect(topics).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await topics.nth(index).locator('summary').click();
    await topics
      .nth(index)
      .getByRole('button', { name: '打开专题', exact: true })
      .click();
    const count = await page.getByTestId('spatial-record-count').textContent();
    expect(count).toMatch(/[1-9]/);
    const downloadEvent = page.waitForEvent('download');
    await topics
      .nth(index)
      .getByRole('button', { name: '导出许可内专题索引', exact: true })
      .click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/^wiser-topic-/);
    if (output)
      await download.saveAs(join(output, download.suggestedFilename()));
  }
});
test('Chinese keyboard, reduced motion, English dark layout and truthful no-WebGL fallback', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'getContext',
    )?.value as HTMLCanvasElement['getContext'];
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).startsWith('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
    localStorage.setItem('wiser-theme', 'dark');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/en/data-foundation/spatial-workspace');
  await expect(page.getByTestId('spatial-geographic-map')).toHaveAttribute(
    'data-renderer',
    'planar',
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('navigation', { name: 'Browse region' }),
  ).toBeVisible();
  const horizontal = await page.evaluate(
    () => document.documentElement.scrollWidth - innerWidth,
  );
  expect(horizontal).toBeLessThanOrEqual(1);
  await page.getByRole('tab', { name: 'Space and evidence' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: 'Readiness and review' }),
  ).toHaveAttribute('aria-selected', 'true');
  if (output)
    await page.screenshot({
      path: join(output, 'english-dark-390.png'),
      fullPage: true,
    });
});
