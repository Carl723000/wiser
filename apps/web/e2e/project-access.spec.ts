import { expect, test, type Page } from '@playwright/test';
test.skip(
  !process.env.WISER_ACCESS_E2E_ORIGIN,
  'Requires an isolated real Auth fixture.',
);
// Credentials come only from a caller-provided ignored environment; never trace login.
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Isolated access fixture requires ${name}`);
  return value;
}
async function login(page: Page, role: 'MANAGER' | 'READER', locale: string) {
  await page.goto(`/${locale}/account/access`);
  await page
    .locator('input[name="email"]')
    .fill(required(`WISER_ACCESS_E2E_${role}_EMAIL`));
  await page
    .locator('input[name="password"]')
    .fill(required(`WISER_ACCESS_E2E_${role}_PASSWORD`));
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`**/${locale}/account/access`);
}
test('real reader session is scoped; both locales and responsive account navigation remain usable', async ({
  page,
}) => {
  await login(page, 'READER', 'zh-CN');
  await expect(
    page.getByRole('heading', { name: '我的访问', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '成员与权限', exact: true }),
  ).toHaveCount(0);
  const r = await page.request.get(
    '/api/platform/access/members?projectId=' +
      required('WISER_ACCESS_E2E_PROJECT_ID'),
  );
  expect(r.status()).toBe(403);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      page.getByRole('link', { name: /WISER/ }).first(),
    ).toBeInViewport();
    await page.getByText('账户', { exact: true }).click();
    await expect(
      page.getByRole('link', { name: '项目访问管理', exact: true }),
    ).toBeInViewport();
    await page.getByText('账户', { exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto('/en/account/access');
  await expect(
    page.getByRole('heading', { name: 'My access', exact: true }),
  ).toBeVisible();
  await page.getByText('Account', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('link', { name: 'Project access', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /dark mode/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
test('real manager changes expiry and revokes the synthetic reader through the page', async ({
  page,
}) => {
  await login(page, 'MANAGER', 'zh-CN');
  await page.getByRole('button', { name: '成员与权限', exact: true }).click();
  const member = page
    .getByRole('row')
    .filter({ hasText: required('WISER_ACCESS_E2E_READER_EMAIL') });
  await expect(member).toBeVisible();
  await member.getByRole('button', { name: '调整权限' }).click();
  const deadline = new Date(Date.now() + 2 * 86400000);
  deadline.setHours(12, 0, 0, 0);
  const inputDate = new Date(
    deadline.valueOf() - deadline.getTimezoneOffset() * 60000,
  )
    .toISOString()
    .slice(0, 16);
  await page.locator('input[name="expires"]').fill(inputDate);
  await page
    .locator('textarea[name="reason"]')
    .fill('隔离浏览器验收：调整资料查阅有效期');
  await page.getByRole('button', { name: '保存授权', exact: true }).click();
  await expect(member).toContainText(deadline.toLocaleDateString('zh-CN'));
  await member.getByRole('button', { name: '撤销访问' }).click();
  await page
    .locator('textarea[name="reason"]')
    .fill('隔离浏览器验收：撤销此项目访问');
  await page
    .getByRole('button', { name: '撤销访问', exact: true })
    .last()
    .click();
  await expect(member).toContainText('已撤销');
  const context = await page
    .context()
    .browser()!
    .newContext({ baseURL: required('WISER_ACCESS_E2E_ORIGIN') });
  try {
    const reader = await context.newPage();
    await login(reader, 'READER', 'zh-CN');
    await expect(reader.getByText('已撤销', { exact: true })).toBeVisible();
    await expect(
      reader.getByRole('heading', { name: '我的访问', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
