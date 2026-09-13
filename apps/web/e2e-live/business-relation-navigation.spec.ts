import { expect, test } from '@playwright/test';
import { loadLiveCredentials } from './support/live-fixture';

const credentials = loadLiveCredentials();
const serialized = process.env['WISER_WEB_LIVE_RELATION_URL'];
if (!serialized) throw Error('A local real relation case URL is required');
const target = new URL(serialized);
if (
  target.origin !== process.env['WISER_WEB_LIVE_BASE_URL'] ||
  !/^\/(en|zh-CN)\/data-foundation\/catalog\/[a-f0-9-]+$/.test(
    target.pathname,
  ) ||
  !target.searchParams.has('relations')
)
  throw Error('Expected a loopback version-bound relation case');
const destination = target.pathname + target.search + target.hash;

test.use({ actionTimeout: 30000 });
test('retains the real business graph across source records and map navigation', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/zh-CN/login?next=' + encodeURIComponent(destination));
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const relations = page.locator('#business-relations');
  await expect(
    relations.getByRole('link', { name: '查看来源记录' }).first(),
  ).toBeVisible({ timeout: 30000 });
  const before = new URL(page.url()).searchParams.get('relations');
  await relations.getByRole('link', { name: '查看来源记录' }).first().click();
  const returnLink = page.getByRole('link', { name: '返回刚才的业务关系图' });
  await expect(returnLink).toBeVisible({ timeout: 30000 });
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('returnRelations')!),
  ).toEqual(JSON.parse(before!));
  await page.reload();
  await expect(returnLink).toBeVisible({ timeout: 30000 });
  await returnLink.click();
  await expect(
    relations.getByRole('link', { name: '查看来源空间内容' }).first(),
  ).toBeVisible({ timeout: 30000 });
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('relations')!),
  ).toEqual(JSON.parse(before!));
  await relations
    .getByRole('link', { name: '查看来源空间内容' })
    .first()
    .click();
  await expect(returnLink).toBeVisible({ timeout: 30000 });
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(returnLink).toBeVisible({ timeout: 30000 });
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('returnRelations')!),
  ).toEqual(JSON.parse(before!));
  await returnLink.click();
  await expect(
    relations.getByRole('link', { name: '查看来源记录' }).first(),
  ).toBeVisible({ timeout: 30000 });
});

test('filters real observation relations and preserves the conditions through refresh and source return', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto('/zh-CN/login?next=' + encodeURIComponent(destination));
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const relations = page.locator('#business-relations');
  await expect(relations.getByLabel('涉及对象类型')).toBeVisible({
    timeout: 30000,
  });
  await relations.getByLabel('涉及对象类型').selectOption('OBSERVATION');
  await relations.getByLabel('筛选时间含义').selectOption('OBSERVATION_TIME');
  await relations.getByLabel('筛选开始日期').fill('2026-06-01');
  await relations.getByLabel('筛选结束日期').fill('2026-09-10');
  await relations.getByLabel('日期筛选时保留时段不明的关系').uncheck();
  await relations.getByRole('button', { name: '应用关系筛选' }).click();
  await expect(relations.locator('article')).toHaveCount(10);
  await expect(
    relations.getByText('筛选后关系数：10', { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(relations.locator('article')).toHaveCount(10, {
    timeout: 30000,
  });
  await expect(relations.getByLabel('涉及对象类型')).toHaveValue('OBSERVATION');
  await relations.getByRole('link', { name: '查看来源记录' }).first().click();
  await page.getByRole('link', { name: '返回刚才的业务关系图' }).click();
  await expect(relations.locator('article')).toHaveCount(10, {
    timeout: 30000,
  });
  await expect(relations.getByLabel('筛选开始日期')).toHaveValue('2026-06-01');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    relations.getByRole('button', { name: '清除关系筛选' }),
  ).toBeVisible();
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.viewport + 1);
});
