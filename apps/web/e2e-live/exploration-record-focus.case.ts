import { expect, test } from '@playwright/test';
import { readRecordFocus } from '../src/lib/exploration-record-focus';
import { loadLiveCredentials } from './support/live-fixture';
const credentials = loadLiveCredentials();
const serialized = process.env['WISER_WEB_LIVE_RECORD_URL'];
if (!serialized) throw Error('A local version-bound record URL is required');
const target = new URL(serialized);
if (
  target.origin !== process.env['WISER_WEB_LIVE_BASE_URL'] ||
  target.pathname !== '/zh-CN/data-foundation/explore'
)
  throw Error('Expected local exploration');
const focus = readRecordFocus(target.searchParams.get('recordFocus'));
if (!focus) throw Error('Record focus required');
const destination = target.pathname + target.search;
test('restores the real selected raster band across map, table and reload', async ({
  page,
}) => {
  test.setTimeout(150000);
  await page.goto('/zh-CN/login?next=' + encodeURIComponent(destination));
  await page.getByLabel('邮箱').fill(credentials.email);
  await page.getByLabel('密码').fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const map = page.getByTestId('explorer-map');
  await expect(map).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(map).toHaveAttribute('data-selected-record', focus.recordId);
  await expect
    .poll(async () =>
      Number(await map.getAttribute('data-rendered-feature-count')),
    )
    .toBeGreaterThan(0);
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('recordFocus')!),
  ).toEqual(focus);
  await page.getByRole('tab', { name: '记录', exact: true }).click();
  const first = page.getByRole('button', { name: '选择记录 1', exact: true });
  await expect(first).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30000,
  });
  await page.reload();
  await expect(first).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30000,
  });
  await page.getByRole('button', { name: '选择记录 2', exact: true }).click();
  const second = readRecordFocus(
    new URL(page.url()).searchParams.get('recordFocus')!,
  );
  if (!second) throw Error('Selected record focus missing');
  expect(second.recordId).not.toBe(focus.recordId);
  expect(second.versionId).toBe(focus.versionId);
  await page.getByRole('tab', { name: '地图', exact: true }).click();
  await expect(map).toHaveAttribute('data-ready', 'true', { timeout: 45000 });
  await expect(map).toHaveAttribute('data-selected-record', second.recordId);
  await page.reload();
  await expect(map).toHaveAttribute('data-selected-record', second.recordId, {
    timeout: 45000,
  });
  const back = page.getByRole('link', { name: '返回刚才的业务关系图' });
  await expect(back).toBeVisible();
  const before: unknown = JSON.parse(
    new URL(page.url()).searchParams.get('returnRelations')!,
  );
  await back.click();
  await expect(
    page
      .locator('#business-relations')
      .getByRole('button', { name: '应用关系筛选' }),
  ).toBeVisible({ timeout: 30000 });
  expect(
    JSON.parse(new URL(page.url()).searchParams.get('relations')!),
  ).toEqual(before);
});
