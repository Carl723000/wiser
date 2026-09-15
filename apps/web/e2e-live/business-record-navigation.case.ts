import { expect, test } from '@playwright/test';
import { loadLiveCredentials } from './support/live-fixture';
import { readRecordFocus } from '../src/lib/exploration-record-focus';
const credentials = loadLiveCredentials();
const serialized = process.env['WISER_WEB_LIVE_RELATION_URL'];
if (!serialized) throw Error('A local real case is required');
const target = new URL(serialized);
if (target.origin !== process.env['WISER_WEB_LIVE_BASE_URL'])
  throw Error('Expected local case');
const destination = target.pathname + target.search + target.hash;
test('opens a real business observation in its exact map record and returns to its graph neighborhood', async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.goto('/zh-CN/login?next=' + encodeURIComponent(destination));
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const relations = page.locator('#business-relations');
  const record = relations
    .getByRole('button', { name: 'TCI影像波段1', exact: true })
    .first();
  await expect(record).toBeVisible({ timeout: 45000 });
  await record.click();
  await expect(relations.locator('article')).toHaveCount(2, { timeout: 30000 });
  const before: unknown = JSON.parse(
    new URL(page.url()).searchParams.get('relations')!,
  );
  await relations
    .getByRole('link', { name: '查看对应记录的空间内容', exact: true })
    .first()
    .click();
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith('/explore') && url.searchParams.has('recordFocus'),
    { timeout: 30000 },
  );
  const focus = readRecordFocus(
    new URL(page.url()).searchParams.get('recordFocus'),
  );
  if (!focus) throw Error('Missing exact record identity');
  const map = page.getByTestId('explorer-map');
  await expect(map).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(map).toHaveAttribute('data-selected-record', focus.recordId);
  await expect
    .poll(async () =>
      Number(await map.getAttribute('data-rendered-feature-count')),
    )
    .toBeGreaterThan(0);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '选择记录 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
  await page.reload();
  await expect(
    page.getByRole('button', { name: '选择记录 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true', { timeout: 30000 });
  await page.getByRole('link', { name: '返回刚才的业务关系图' }).click();
  await expect(relations.locator('article')).toHaveCount(2, { timeout: 30000 });
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('relations')!),
  ).toEqual(before);
  await expect(record).toBeVisible();
});
