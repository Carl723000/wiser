import { defineConfig } from '@playwright/test';
import liveConfig from './playwright.live.config';

// Real source cases have additional, explicitly supplied fixture contracts.
// Keep their strict validation while excluding them from portable CI discovery.
export default defineConfig(liveConfig, {
  testMatch: '**/*.case.ts',
});
