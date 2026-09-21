import { expect, test } from '@playwright/test';
import { loadLiveCredentials } from './support/live-fixture';

const credentials = loadLiveCredentials();

test('authorized project home renders the complete graph without unstable child keys', async ({
  page,
}) => {
  test.setTimeout(120000);
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on('console', (message) => {
    if (/unique.*key|same key|key.*prop/i.test(message.text()))
      warnings.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.name));
  await page.goto('/zh-CN/login?next=/zh-CN/data-foundation');
  await page.getByLabel('邮箱', { exact: true }).fill(credentials.email);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const scene = page.getByTestId('business-scene');
  await expect(scene).toBeVisible({ timeout: 90000 });
  const count = Number(await scene.getAttribute('data-edge-count'));
  expect(count).toBeGreaterThan(0);
  await expect(page.getByTestId('data-explorer')).toHaveAttribute(
    'data-query-id',
    /.+/,
  );
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});
