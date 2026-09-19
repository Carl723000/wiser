import { expect, test } from '@playwright/test';
import { loadLiveCredentials } from './support/live-fixture';
const credentials = loadLiveCredentials();

test('searches actual authorized resources and preserves the workspace across expand, Escape and refresh', async ({
  page,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto(
    '/zh-CN/login?next=' + encodeURIComponent('/zh-CN/data-foundation/explore'),
  );
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByTestId('data-explorer')).toBeVisible({
    timeout: 45000,
  });
  const resourceLinks = page.getByRole('table').getByRole('link');
  await expect(resourceLinks.first()).toBeVisible({ timeout: 45000 });
  const originalHref = await resourceLinks.first().getAttribute('href');
  const query = await page
    .getByTestId('data-explorer')
    .getAttribute('data-query-id');
  await page.getByRole('button', { name: '全屏工作区', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await resourceLinks.first().getAttribute('href')).toBe(originalHref);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '全屏工作区', exact: true }),
  ).toBeFocused();
  expect(
    await page.getByTestId('data-explorer').getAttribute('data-query-id'),
  ).toBe(query);
  await page
    .getByText('用当前资料名称试搜（重新查询资料范围）', { exact: true })
    .click();
  const example = page.getByRole('button', { name: /^搜索资料 / }).first();
  await expect(example).toBeVisible();
  await example.click();
  await expect(page.getByText('登记名称包含关键词').first()).toBeVisible({
    timeout: 30000,
  });
  const applied = await page.getByLabel('查询数据').inputValue();
  expect(applied.length).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByLabel('查询数据')).toHaveValue(applied, {
    timeout: 30000,
  });
  await page.getByLabel('查询数据').fill('不会存在的资料-76-验收-000000');
  await page.getByLabel('查询数据').press('Enter');
  await expect(
    page.getByRole('button', { name: '清除条件，浏览全部授权资料' }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole('button', { name: '清除条件，浏览全部授权资料' })
    .click();
  await expect(resourceLinks.first()).toBeVisible({ timeout: 30000 });
  await page.goto('/zh-CN/data-foundation');
  const topics = page.getByRole('region', { name: '打开已保存专题' });
  await expect(topics).toBeVisible({ timeout: 30000 });
  const topic = topics.locator('a[href*="?saved="]').first();
  await expect(topic).toBeVisible({ timeout: 30000 });
  const topicHref = await topic.getAttribute('href');
  const topicName = await topic.innerText();
  await topics.getByLabel('查找已保存专题').fill(topicName);
  await expect(topics.locator(`a[href="${topicHref}"]`)).toBeVisible();
  await topics.getByRole('button', { name: '清除专题筛选' }).click();
  await expect(topics.getByLabel('查找已保存专题')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await topics.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '切换至深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({
    path: test.info().outputPath('saved-topics-entry.png'),
    fullPage: true,
  });
  await topics.locator(`a[href="${topicHref}"]`).click();
  await expect(page.getByTestId('data-explorer')).toBeVisible({
    timeout: 30000,
  });
  await expect(page).toHaveURL(
    new RegExp('saved=' + topicHref!.split('saved=')[1]),
  );
  expect(errors).toEqual([]);
});

test('measures the real saved graph and preserves identities through full screen and pan', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const saved = process.env['WISER_WEB_LIVE_SAVED_VIEW'];
  const expected = Number(process.env['WISER_WEB_LIVE_RELATION_COUNT']);
  if (!saved || !Number.isSafeInteger(expected) || expected < 1)
    throw Error('Supply a verified public saved case and relation count');
  const timings: { path: string; ms: number }[] = [];
  page.on('requestfinished', (request) => {
    if (request.url().includes('/api/data-foundation/')) {
      const t = request.timing();
      timings.push({
        path: new URL(request.url()).pathname,
        ms: t.responseEnd,
      });
    }
  });
  await page.goto(
    '/zh-CN/login?next=' +
      encodeURIComponent('/zh-CN/data-foundation/explore?saved=' + saved),
  );
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const graph = page.getByTestId('business-scene');
  await expect(graph).toHaveAttribute('data-edge-count', String(expected), {
    timeout: 90000,
  });
  const ids = await graph
    .locator('[data-node-id]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-node-id')).sort(),
    );
  expect(ids.length).toBeGreaterThan(1);
  const captions = await graph
    .locator('[data-group-caption] rect')
    .evaluateAll((elements) =>
      elements.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }),
    );
  expect(captions.length).toBeGreaterThan(1);
  for (let i = 0; i < captions.length; i++)
    for (const b of captions.slice(i + 1)) {
      const a = captions[i];
      expect(
        a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y,
      ).toBe(true);
    }
  await page.getByRole('button', { name: '全屏工作区', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const svg = graph.getByRole('img', { name: '平面图谱', exact: true });
  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  const metrics = page.evaluate(
    () =>
      new Promise<{
        frames: number;
        p50: number;
        p95: number;
        longest: number;
      }>((resolve) => {
        const times: number[] = [];
        let previous = performance.now();
        const end = previous + 3000;
        function tick(now: number) {
          times.push(now - previous);
          previous = now;
          if (now < end) requestAnimationFrame(tick);
          else {
            times.sort((a, b) => a - b);
            resolve({
              frames: times.length,
              p50: times[Math.floor(times.length * 0.5)],
              p95: times[Math.floor(times.length * 0.95)],
              longest: times.at(-1)!,
            });
          }
        }
        requestAnimationFrame(tick);
      }),
  );
  await svg.focus();
  const initialPan = await svg
    .locator('[data-camera-pan]')
    .getAttribute('transform');
  for (let index = 0; index < 30; index++) {
    await page.keyboard.press(index % 2 ? 'ArrowLeft' : 'ArrowRight');
    if (index === 0)
      expect(
        await svg.locator('[data-camera-pan]').getAttribute('transform'),
      ).not.toBe(initialPan);
    await page.waitForTimeout(25);
  }
  const frameMetrics = await metrics;
  expect(
    await graph
      .locator('[data-node-id]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-node-id')).sort(),
      ),
  ).toEqual(ids);
  await page.getByRole('button', { name: '流畅优先', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '流畅优先', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('businessStyle')).toBe('smooth');
  expect(await graph.locator('[data-node-id]').count()).toBe(ids.length);
  await svg.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('real-graph.png') });
  await testInfo.attach('real-graph-legend', {
    path: testInfo.outputPath('real-graph.png'),
    contentType: 'image/png',
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('button', { name: '流畅优先', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 90000 });
  expect(await graph.locator('[data-node-id]').count()).toBe(ids.length);
  const report = {
    browser: page.context().browser()?.version(),
    measurement:
      'headless Chromium on local host; no device emulation; 3s keyboard pan',
    nodes: ids.length,
    relations: expected,
    frameIntervalsMs: frameMetrics,
    requests: timings,
  };
  await testInfo.attach('graph-interaction-measurement', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(JSON.stringify(report));
});

test('retains real public spatial anchors and unlocated evidence across presentation changes', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const saved = process.env['WISER_WEB_LIVE_SAVED_VIEW'];
  const expected = Number(process.env['WISER_WEB_LIVE_RELATION_COUNT']);
  if (!saved || !Number.isSafeInteger(expected) || expected < 1)
    throw Error('Supply a verified public saved case and relation count');
  await page.goto(
    '/zh-CN/login?next=' +
      encodeURIComponent('/zh-CN/data-foundation/explore?saved=' + saved),
  );
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const graph = page.getByTestId('business-scene');
  await expect(graph).toHaveAttribute('data-edge-count', String(expected), {
    timeout: 90000,
  });
  const originalIds = await graph
    .locator('[data-node-id]')
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-node-id')).sort(),
    );
  await page.getByRole('button', { name: '空间锚点', exact: true }).click();
  const spatial = page.getByTestId('business-spatial-scene');
  await expect(spatial).toHaveAttribute('data-state', 'ready', {
    timeout: 45000,
  });
  const anchorCount = Number(await spatial.getAttribute('data-anchor-count'));
  console.log(
    JSON.stringify({
      nodes: originalIds.length,
      anchors: anchorCount,
      relations: expected,
    }),
  );
  await testInfo.attach('spatial-source-counts', {
    body: JSON.stringify({
      nodes: originalIds.length,
      anchors: anchorCount,
      relations: expected,
    }),
    contentType: 'application/json',
  });
  expect(anchorCount).toBeGreaterThan(0);
  await expect(page.getByTestId('amap-basemap')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 35000 },
  );
  expect(
    await spatial
      .locator('[data-node-id]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-node-id')).sort(),
      ),
  ).toEqual(originalIds);
  expect(
    await spatial.locator('[data-anchored="false"]').count(),
  ).toBeGreaterThan(0);
  expect(await spatial.locator('[data-edge-id]').count()).toBe(expected);
  await spatial.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('real-spatial-anchors.png'),
  });
  await page.getByRole('button', { name: '平面图谱', exact: true }).click();
  expect(
    await graph
      .locator('[data-node-id]')
      .evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute('data-node-id')).sort(),
      ),
  ).toEqual(originalIds);
});
