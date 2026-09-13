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
