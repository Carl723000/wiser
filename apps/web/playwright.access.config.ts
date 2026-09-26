import { defineConfig } from '@playwright/test';
const origin = process.env.WISER_ACCESS_E2E_ORIGIN;
if (!origin || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('An isolated loopback access preview is required.');
export default defineConfig({
  testDir: './e2e',
  testMatch: 'project-access.spec.ts',
  workers: 1,
  timeout: 60000,
  reporter: 'list',
  use: { baseURL: origin, trace: 'off', screenshot: 'off', video: 'off' },
});
