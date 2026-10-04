import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const route = '/zh-CN/data-foundation/spatial-workspace';
const output = process.env.WISER_SPATIAL_ACCEPTANCE_DIRECTORY;
const browserErrors = new WeakMap<BrowserContext, string[]>();
const browserWarnings = new WeakMap<BrowserContext, string[]>();

/** Select the actual permitted record first; the product supplies its fixed pins. */
async function openFixedRecord(
  page: Page,
  locale: 'zh-CN' | 'en',
  recordId: string,
) {
  await page.goto(`/${locale}/data-foundation/spatial-workspace`);
  const workspace = page.getByTestId('spatial-workspace');
  const labels =
    locale === 'zh-CN'
      ? { filters: '资料筛选', search: '查找对象或来源', results: '结果' }
      : {
          filters: 'Filter materials',
          search: 'Find object or source',
          results: 'Results',
        };
  const results = workspace.getByRole('tab', {
    name: labels.results,
    exact: true,
  });
  const viewport = page.viewportSize();
  if (viewport && (viewport.width <= 1100 || viewport.height <= 500)) {
    await expect(results).toBeVisible();
    await results.click();
    await expect(results).toHaveAttribute('aria-selected', 'true');
  }
  const filters = workspace
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: labels.filters }) })
    .first();
  if ((await filters.getAttribute('open')) === null)
    await filters.locator('summary').click();
  await workspace.getByLabel(labels.search, { exact: true }).fill(recordId);
  const row = workspace
    .getByRole('table')
    .getByRole('row')
    .filter({ has: page.locator('th[scope="row"]') });
  await expect(row).toHaveCount(1);
  await row.getByRole('button').click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('record'))
    .toBe(recordId);
  const fixed = new URL(page.url());
  for (const name of [
    'source',
    'version',
    'sourceHash',
    'sourceRule',
    'recordRule',
  ])
    expect(fixed.searchParams.get(name)).toBeTruthy();
  // Reloading the product-generated link removes only the temporary search;
  // record, location, scope and active pane must come from the URL again.
  await page.goto(fixed.href);
  // The mobile pane tabs appear after the responsive layout settles. Wait for
  // that real control before checking whether the filters are collapsed.
  if (viewport && (viewport.width <= 1100 || viewport.height <= 500))
    await expect(
      workspace.getByRole('tab', { name: labels.results, exact: true }),
    ).toBeVisible();
}

test('fixed reading links retain exact days, pane and position through refresh, source return and explicit matrix scope changes', async ({
  page,
}) => {
  for (const [locale, labels] of [
    [
      'zh-CN',
      {
        filters: '资料筛选',
        start: '起始日期',
        end: '结束日期',
        evidence: '证据',
        dossier: '对象证据档案',
        return: '返回空间工作台',
        readiness: '资料就绪与复核',
        chooseMonth: '选择月份窗口',
        spatial: '空间与证据',
        invalid: '阅读链接不可用',
      },
    ],
    [
      'en',
      {
        filters: 'Filter materials',
        start: 'Start date',
        end: 'End date',
        evidence: 'Evidence',
        dossier: 'Object evidence dossier',
        return: 'Return to spatial workspace',
        readiness: 'Readiness and review',
        chooseMonth: 'Choose month window',
        spatial: 'Space and evidence',
        invalid: 'Reading link unavailable',
      },
    ],
  ] as const) {
    await page.setViewportSize({
      width: locale === 'zh-CN' ? 390 : 1440,
      height: 1000,
    });
    await openFixedRecord(page, locale, 'monthly-2023-04:t1:r14');
    const workspace = page.getByTestId('spatial-workspace');
    const filters = workspace
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: labels.filters }) })
      .first();
    if ((await filters.getAttribute('open')) === null)
      await filters.locator('summary').click();
    await workspace
      .getByLabel(labels.start, { exact: true })
      .fill('2023-04-01');
    await workspace.getByLabel(labels.end, { exact: true }).fill('2023-04-17');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dayEnd'))
      .toBe('2023-04-17');
    const pinned = new URL(page.url());
    expect(pinned.searchParams.get('monthEnd')).toBeNull();
    expect(pinned.searchParams.get('position')).toBeTruthy();
    const position = pinned.searchParams.get('position');
    await page.reload();
    await expect(
      workspace.getByLabel(labels.start, { exact: true }),
    ).toHaveValue('2023-04-01');
    await expect(workspace.getByLabel(labels.end, { exact: true })).toHaveValue(
      '2023-04-17',
    );
    // Click the real global language control in both directions. Opening two
    // locale URLs independently does not exercise query preservation.
    const themeToggle = page.locator('button[data-theme]');
    await expect(themeToggle).toBeVisible();
    await themeToggle.click();
    const theme = await themeToggle.getAttribute('data-theme');
    expect(theme).toMatch(/^(light|dark)$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    const otherLocale = locale === 'zh-CN' ? 'en' : 'zh-CN';
    const languageLink = page.locator(`a[hreflang="${otherLocale}"]`);
    await expect(languageLink).toBeVisible();
    const languageDestination = new URL(
      (await languageLink.getAttribute('href'))!,
      page.url(),
    );
    for (const [key, value] of pinned.searchParams)
      expect(languageDestination.searchParams.get(key)).toBe(value);
    await languageLink.click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/${otherLocale}/data-foundation/spatial-workspace`);
    await expect(page.locator('html')).toHaveAttribute('lang', otherLocale);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    for (const [key, value] of pinned.searchParams)
      expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    await page.locator(`a[hreflang="${locale}"]`).click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/${locale}/data-foundation/spatial-workspace`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
    for (const [key, value] of pinned.searchParams)
      expect(new URL(page.url()).searchParams.get(key)).toBe(value);
    const dossier = workspace.getByRole('region', { name: labels.dossier });
    const source = await dossier.getByRole('link').first().getAttribute('href');
    expect(new URL(source!, page.url()).searchParams.get('dayEnd')).toBe(
      '2023-04-17',
    );
    await page.goto(source!);
    await page.getByRole('link', { name: labels.return, exact: true }).click();
    await expect(
      page
        .getByTestId('spatial-workspace')
        .getByLabel(labels.end, { exact: true }),
    ).toHaveValue('2023-04-17');
    expect(new URL(page.url()).searchParams.get('position')).toBe(position);
    await page
      .getByRole('tab', { name: labels.readiness, exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: labels.chooseMonth, exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get('dayEnd')).toBe('2023-04-17');
    await expect(page.locator('[data-matrix-region]')).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('button', { name: labels.chooseMonth, exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: labels.chooseMonth, exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.has('dayEnd'))
      .toBe(false);
    const cell = page.locator(
      '[data-matrix-region="beiyun"][data-matrix-need="K5-002"]',
    );
    await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('tab', { name: labels.spatial, exact: true }).click();
    await page.goBack();
    await expect(
      page.getByRole('tab', { name: labels.readiness, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await page.goForward();
    await expect(
      page.getByRole('tab', { name: labels.spatial, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(new URL(page.url()).searchParams.get('region')).toBe('beiyun');
    await page.goBack();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    expect(new URL(page.url()).searchParams.get('region')).toBe('beiyun');
    expect(new URL(page.url()).searchParams.get('need')).toBe('K5-002');
    const invalid = new URL(pinned.href);
    invalid.searchParams.append('record', 'monthly-2023-04:t1:r38');
    await page.goto(invalid.href);
    await expect(
      page.getByRole('heading', { name: labels.invalid, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('spatial-workspace')).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: labels.dossier }),
    ).toHaveCount(0);
  }
});

test('map role legend and selected reference remain readable across locales, mobile panes and fullscreen', async ({
  page,
}) => {
  for (const [locale, labels] of [
    [
      'zh-CN',
      {
        legend: '地图图例',
        location: '当前地图位置',
        reference: '参考位置或范围',
        limit: '参考范围，不能代替精确位置',
        map: '地图',
        fullscreen: '全屏工作区',
      },
    ],
    [
      'en',
      {
        legend: 'Map legend',
        location: 'Current map location',
        reference: 'Reference location or extent',
        limit: 'Reference extent; not an exact location',
        map: 'Map',
        fullscreen: 'Expand workspace',
      },
    ],
  ] as const) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await openFixedRecord(page, locale, 'monthly-2023-04:t1:r14');
      if (width === 390)
        await page.getByRole('tab', { name: labels.map, exact: true }).click();
      await expect(
        page.getByRole('group', { name: labels.legend }),
      ).toContainText(labels.reference);
      const location = page.getByRole('region', { name: labels.location });
      await expect(location).toContainText('潮白河');
      await expect(location).toContainText(labels.reference);
      await expect(location).toContainText(labels.limit);
      await page
        .getByRole('button', { name: labels.fullscreen, exact: true })
        .click();
      await expect(location).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (output)
        await page.screenshot({
          path: join(output, `${locale}-map-roles-${width}.png`),
        });
      await page.keyboard.press('Escape');
    }
  }
});

test('business evidence stays readable while exact technical references remain available by keyboard in both locales and viewport sizes', async ({
  page,
}) => {
  for (const [locale, labels] of [
    [
      'zh-CN',
      {
        dossier: '对象证据档案',
        technical: '技术详情',
        identity: '对象身份说明',
        original: '查看公开原文',
        status: '待专业核验',
        evidence: '证据',
        map: '地图',
        reading: '查阅区域',
      },
    ],
    [
      'en',
      {
        dossier: 'Object evidence dossier',
        technical: 'Technical details',
        identity: 'Object identity information',
        original: 'Read public original',
        status: 'Pending professional verification',
        evidence: 'Evidence',
        map: 'Map',
        reading: 'Reading pane',
      },
    ],
  ] as const) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await openFixedRecord(page, locale, 'monthly-2023-04:t1:r14');
      const dossier = page.getByRole('region', { name: labels.dossier });
      await expect(
        dossier.getByText(labels.status, { exact: true }),
      ).toBeVisible();
      const record = dossier.getByText('monthly-2023-04:t1:r14', {
        exact: true,
      });
      await expect(record).toBeHidden();
      const original = dossier.getByRole('link', { name: labels.original });
      await expect(original).toBeVisible();
      const href = await original.getAttribute('href');
      const summary = dossier.getByText(labels.technical, { exact: true });
      await summary.focus();
      await summary.press('Enter');
      await expect(record).toBeVisible();
      await expect(original).toHaveAttribute('href', href!);
      await summary.press('Enter');
      await expect(record).toBeHidden();
      const help = dossier.getByRole('button', { name: labels.identity });
      await help.click();
      await expect(help).toHaveAttribute('aria-expanded', 'true');
      await help.press('Escape');
      await expect(help).toHaveAttribute('aria-expanded', 'false');
      if (width === 390) {
        const tabs = page.getByRole('tablist', { name: labels.reading });
        await tabs.getByRole('tab', { name: labels.map, exact: true }).click();
        await tabs
          .getByRole('tab', { name: labels.evidence, exact: true })
          .click();
        await expect(record).toBeHidden();
        await expect(original).toHaveAttribute('href', href!);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (output)
        await page.screenshot({
          path: join(output, `${locale}-business-evidence-${width}.png`),
        });
    }
  }
});

test('WebGL gestures cannot restore an obsolete camera after reset, hidden panes, viewport changes or fullscreen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(route);
  const workspace = page.getByTestId('spatial-workspace');
  const map = workspace.getByTestId('spatial-geographic-map');
  const tabs = workspace.getByRole('tablist', { name: '查阅区域' });
  await expect(map).toHaveAttribute('data-renderer', 'maplibre');
  const nativeCanvas = map.locator('canvas');
  await nativeCanvas.scrollIntoViewIfNeeded();
  const before = await map.getAttribute('data-camera');
  const box = (await nativeCanvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, {
    steps: 20,
  });
  await page.mouse.up();
  await expect.poll(() => map.getAttribute('data-camera')).not.toBe(before);
  await page.waitForTimeout(2200);
  const gesture = await map.getAttribute('data-camera');
  await workspace
    .getByRole('button', { name: '复位相机', exact: true })
    .click();
  await expect(map).toHaveAttribute('data-camera', before!);
  expect(gesture).not.toBe(before);
  const originalMap = await map.elementHandle();
  await tabs.getByRole('tab', { name: '结果', exact: true }).click();
  await page.waitForTimeout(150);
  await tabs.getByRole('tab', { name: '地图', exact: true }).click();
  await page.waitForTimeout(150);
  await expect(map).toHaveAttribute('data-camera', before!);
  for (const [width, height] of [
    [768, 1024],
    [834, 1112],
    [1024, 768],
    [1100, 800],
    [844, 390],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(tabs).toBeVisible();
    await expect(workspace.getByRole('tabpanel')).toHaveCount(1);
    await expect(map).toHaveAttribute('data-camera', before!);
  }
  await page.getByRole('button', { name: '全屏工作区', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(map).toHaveAttribute('data-camera', before!);
  for (const width of [1101, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(tabs).toHaveCount(0);
    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute('data-camera', before!);
  }
  expect(
    await map.evaluate((node, original) => node === original, originalMap),
  ).toBe(true);
});
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
  const quantity = page
    .getByRole('heading', { name: '有多少' })
    .locator('..')
    .locator('..');
  await quantity.getByRole('button', { name: '查看明细', exact: true }).click();
  const records = page
    .getByRole('region', { name: '有多少' })
    .getByRole('group', { name: '原表记录' });
  await records.getByRole('button').nth(1).click();
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
  await expect(
    page.getByRole('region', { name: '资料就绪管理' }).getByRole('status'),
  ).toContainText('受影响记录需重新核对');
  await expect(
    page.getByRole('region', { name: '资料就绪管理' }).getByRole('status'),
  ).toBeVisible();
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
  await expect(page.locator('#spatial-panel-raster img')).toHaveCount(0);
  await expect(page.locator('#spatial-panel-raster')).toContainText(
    '当前可见筛选范围内没有适用的影像检查结果。',
  );
  await expect
    .poll(() => new URL(page.url()).searchParams.get('region'))
    .toBe('chaobai');
  await page.getByRole('tab', { name: '资料就绪与复核' }).click();
  await page
    .getByRole('combobox', { name: '浏览范围', exact: true })
    .selectOption('yongding');
  await page.getByLabel('需求', { exact: true }).selectOption('K5-005');
  await page.getByRole('tab', { name: '遥感检查' }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('region'))
    .toBe('yongding');
  await expect
    .poll(() => new URL(page.url()).searchParams.get('need'))
    .toBe('K5-005');
  await expect(page.locator('#spatial-panel-raster article')).toHaveCount(1);
  await expect(
    page.locator('#spatial-panel-raster').getByRole('heading', { level: 3 }),
  ).toHaveText('官厅水库 Sentinel-2 保留影像检查（2026-08-24）');
  await expect(page.locator('#spatial-panel-raster')).toContainText(
    'S2B_MSIL2A_20260824T030519_N0512_R075_T50TLK_20260824T065641.SAFE',
  );
  await expect(
    page.locator('#spatial-panel-raster').getByRole('heading', { level: 4 }),
  ).toHaveText(['B03', 'B8A', 'SCL', 'TCI']);
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
    await openFixedRecord(page, 'zh-CN', id);
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
    const wrong = new URL(fixed!, page.url());
    wrong.searchParams.set('version', 'missing-fixed-version');
    const invalidSource = await page.context().newPage();
    await invalidSource.goto(wrong.href);
    await expect(invalidSource.getByRole('alert')).toContainText(
      '链接信息不完整，或所选资料与范围已失效',
    );
    await expect(
      invalidSource.getByRole('heading', { name: object, exact: true }),
    ).toHaveCount(0);
    await invalidSource.close();
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

test.describe('narrow spatial reading', () => {
  test.use({ hasTouch: true });
  for (const locale of ['zh-CN', 'en'] as const) {
    test(`${locale} narrow reading preserves the map, filters, exact evidence and fullscreen return`, async ({
      page,
    }) => {
      const labels =
        locale === 'zh-CN'
          ? {
              panes: '查阅区域',
              map: '地图',
              zoom: '放大地图',
              results: '结果',
              evidence: '证据',
              dossier: '对象证据档案',
              filters: '资料筛选',
              start: '起始日期',
              end: '结束日期',
              records: '区域资料清单',
              locate: '查看此位置',
              sourceHeading: '提取记录与原文定位',
              fullscreen: '全屏工作区',
              spatial: '空间与证据',
            }
          : {
              panes: 'Reading pane',
              map: 'Map',
              zoom: 'Zoom in',
              results: 'Results',
              evidence: 'Evidence',
              dossier: 'Object evidence dossier',
              filters: 'Filter materials',
              start: 'Start date',
              end: 'End date',
              records: 'Regional material records',
              locate: 'Inspect this location',
              sourceHeading: 'Extracted records and original locators',
              fullscreen: 'Expand workspace',
              spatial: 'Space and evidence',
            };
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
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await openFixedRecord(page, locale, 'monthly-2023-04:t1:r14');
      const workspace = page.getByTestId('spatial-workspace');
      const tabs = workspace.getByRole('tablist', { name: labels.panes });
      const evidence = tabs.getByRole('tab', {
        name: labels.evidence,
        exact: true,
      });
      const mapTab = tabs.getByRole('tab', { name: labels.map, exact: true });
      const results = tabs.getByRole('tab', {
        name: labels.results,
        exact: true,
      });
      await expect(evidence).toHaveAttribute('aria-selected', 'true');
      await expect(workspace.getByRole('tabpanel')).toHaveCount(1);
      const dossier = workspace.getByRole('region', { name: labels.dossier });
      await expect(dossier).toContainText('monthly-2023-04:t1:r14');
      await expect(dossier).toContainText('table:1/row:14');
      const sourceHref = await dossier
        .getByRole('link')
        .first()
        .getAttribute('href');
      const map = workspace.getByTestId('spatial-geographic-map');
      const originalMap = await map.elementHandle();
      await expect(map).toHaveAttribute('data-renderer', 'planar');
      await dossier.getByRole('button', { name: labels.locate }).click();
      await expect(mapTab).toHaveAttribute('aria-selected', 'true');
      await expect(workspace.getByRole('tabpanel')).toBeFocused();
      await expect(map).toBeVisible();
      const camera = await map.getAttribute('data-camera');
      const filter = workspace
        .locator('details')
        .filter({
          has: page.locator('summary', { hasText: labels.filters }),
        })
        .first();
      await expect(filter).not.toHaveAttribute('open', '');
      await filter.locator('summary').first().click();
      await workspace
        .getByLabel(labels.start, { exact: true })
        .fill('2023-04-01');
      await workspace
        .getByLabel(labels.end, { exact: true })
        .fill('2023-04-30');
      await filter.locator('summary').first().click();
      const count = await workspace
        .getByTestId('spatial-record-count')
        .textContent();
      await mapTab.focus();
      await page.keyboard.press('ArrowRight');
      await expect(results).toBeFocused();
      const records = workspace.getByRole('region', { name: labels.records });
      await expect(records).toBeVisible();
      await expect(map).not.toBeVisible();
      await records
        .getByRole('row')
        .filter({ hasText: '潮白河上段' })
        .filter({ hasText: '2023-04' })
        .first()
        .getByRole('button')
        .click();
      await expect(evidence).toHaveAttribute('aria-selected', 'true');
      await expect(workspace.getByRole('tabpanel')).toBeFocused();
      await expect(dossier).toContainText('monthly-2023-04:t1:r14');
      const filteredSourceHref = await dossier
        .getByRole('link')
        .first()
        .getAttribute('href');
      const expectedSource = new URL(sourceHref!, page.url());
      expectedSource.searchParams.set('includeUndated', 'true');
      expectedSource.searchParams.set('dayStart', '2023-04-01');
      expectedSource.searchParams.set('dayEnd', '2023-04-30');
      const filteredSource = new URL(filteredSourceHref!, page.url());
      expect(filteredSource.origin).toBe(expectedSource.origin);
      expect(filteredSource.pathname).toBe(expectedSource.pathname);
      // Every original identity and location pin remains fixed; only the
      // explicitly changed date scope is added to the source round trip.
      expect([...filteredSource.searchParams.entries()].sort()).toEqual(
        [...expectedSource.searchParams.entries()].sort(),
      );
      await expect(workspace.getByTestId('spatial-record-count')).toHaveText(
        count!,
      );
      await expect(map).toHaveAttribute('data-camera', camera!);
      const sourcePage = await page.context().newPage();
      await sourcePage.goto(filteredSource.href);
      await expect(
        sourcePage.getByRole('heading', { name: labels.sourceHeading }),
      ).toBeVisible();
      await expect(sourcePage.locator('blockquote').first()).not.toBeEmpty();
      await sourcePage.close();
      await page
        .getByRole('button', { name: labels.fullscreen, exact: true })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(evidence).toHaveAttribute('aria-selected', 'true');
      await mapTab.tap();
      await expect(map).toBeVisible();
      expect(
        await map.evaluate((node, original) => node === original, originalMap),
      ).toBe(true);
      await expect(map).toHaveAttribute('data-camera', camera!);
      const horizontal = await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      );
      expect(horizontal).toBeLessThanOrEqual(1);
      if (output) {
        await tabs.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(output, `${locale}-single-pane-map-390.png`),
        });
      }
      await evidence.tap();
      await expect(evidence).toHaveAttribute('aria-selected', 'true');
      if (output) {
        await tabs.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(output, `${locale}-single-pane-evidence-390.png`),
        });
      }
      await evidence.focus();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(tabs).toHaveCount(0);
      await expect(map).toBeVisible();
      await expect(records).toBeVisible();
      await expect(dossier).toBeVisible();
      await expect(dossier.getByRole('link').first()).toHaveAttribute(
        'href',
        filteredSourceHref!,
      );
      expect(
        await map.evaluate((node, original) => node === original, originalMap),
      ).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(evidence).toHaveAttribute('aria-selected', 'true');
      await expect(workspace.getByRole('tabpanel')).toHaveCount(1);
      await expect(workspace.getByTestId('spatial-record-count')).toHaveText(
        count!,
      );
      await expect(
        page.getByRole('tab', { name: labels.spatial, exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const zoom = workspace.getByRole('button', {
        name: labels.zoom,
        exact: true,
      });
      await zoom.focus();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(mapTab).toHaveAttribute('aria-selected', 'true');
      await expect(zoom).toBeFocused();
      await expect(zoom).toBeVisible();
      expect(
        await map.evaluate((node, original) => node === original, originalMap),
      ).toBe(true);
    });
  }
});
