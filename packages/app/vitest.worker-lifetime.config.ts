import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { appVitestConfig } from './vitest.config';
import { appIntegrationVitestConfig, WORKER_LIFETIME_TESTS } from './vitest.integration.config';

export default defineConfig({
  ...appIntegrationVitestConfig,
  test: {
    ...appIntegrationVitestConfig.test,
    include: [...WORKER_LIFETIME_TESTS],
    exclude: [...appVitestConfig.test.exclude],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
} satisfies ViteUserConfig);
