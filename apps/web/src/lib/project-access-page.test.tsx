// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ viewer: vi.fn(), projects: vi.fn() }));
vi.mock('next/server', () => ({ connection: () => Promise.resolve() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(url);
  },
}));
vi.mock('@/lib/auth', () => ({ readVerifiedAuthViewer: mocks.viewer }));
vi.mock('@/lib/supabase/server', () => ({
  createWiserServerSupabaseClient: () => Promise.resolve({}),
}));
vi.mock('@/lib/project-access.server', () => ({
  getProjectAccessClient: () => ({ projects: mocks.projects }),
}));
import Page from '../app/[locale]/account/access/page';
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it('requires login before querying access and keeps the intended destination', async () => {
  vi.stubEnv('WISER_PROJECT_ACCESS_ENABLED', 'true');
  mocks.viewer.mockResolvedValue(null);
  await expect(
    Page({ params: Promise.resolve({ locale: 'zh-CN' }) }),
  ).rejects.toThrow('/zh-CN/login?next=%2Fzh-CN%2Faccount%2Faccess');
  expect(mocks.projects).not.toHaveBeenCalled();
});
it('shows a safe retry state on service failure without revealing backend details', async () => {
  vi.stubEnv('WISER_PROJECT_ACCESS_ENABLED', 'true');
  mocks.viewer.mockResolvedValue({ email: 'reader@example.test' });
  mocks.projects.mockRejectedValue(new Error('private backend detail'));
  render(await Page({ params: Promise.resolve({ locale: 'zh-CN' }) }));
  expect(screen.getByRole('alert').textContent).toContain('暂时无法');
  expect(screen.queryByText('private backend detail')).toBeNull();
  expect(
    screen.getByRole('link', { name: '重新加载' }).getAttribute('href'),
  ).toBe('/zh-CN/account/access');
});
it('does not expose disabled management routes', async () => {
  vi.stubEnv('WISER_PROJECT_ACCESS_ENABLED', 'false');
  await expect(
    Page({ params: Promise.resolve({ locale: 'en' }) }),
  ).rejects.toThrow('NOT_FOUND');
  expect(mocks.viewer).not.toHaveBeenCalled();
});
