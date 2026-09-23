import { expect, test } from '@playwright/test';

for (const [locale, title, action, invalid] of [
  ['zh-CN', '接受 WISER 邀请', '确认邀请并继续', '邀请链接无效或已过期'],
  [
    'en',
    'Accept your WISER invitation',
    'Accept invitation and continue',
    'Invitation link is invalid or expired',
  ],
] as const) {
  test(`${locale}: explicit acceptance, invalid-link recovery, keyboard and narrow layout`, async ({
    page,
  }) => {
    await page.goto(`/${locale}/auth/invite?token_hash=${'a'.repeat(64)}`);
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: action })).toBeVisible();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      'content',
      'no-referrer',
    );
    // Opening the invitation must not consume it or submit a form.
    await expect(page).toHaveURL(/\/auth\/invite\?token_hash=/);
    await page.getByRole('button', { name: action }).focus();
    await expect(page.getByRole('button', { name: action })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: action })).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.getByRole('button', { name: action })).toBeVisible();
    await page.goto(`/${locale}/auth/invite?reason=invalid`);
    await expect(page.getByRole('heading', { name: invalid })).toBeVisible();
    await expect(page.getByRole('button', { name: action })).toHaveCount(0);
  });
}
