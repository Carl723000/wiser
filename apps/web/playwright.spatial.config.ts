import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e-spatial',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  outputDir: process.env.WISER_SPATIAL_TEST_OUTPUT ?? './test-results/spatial',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3410',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
