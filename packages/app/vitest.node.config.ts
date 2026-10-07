import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

export const APP_NODE_SETUP_FILES = [
  ...okVitestBase.test.setupFiles,
  fileURLToPath(new URL('./tests/foundation/node-destination-setup.ts', import.meta.url)),
];

const NODE_TEST_FILES = '**/*.node.test.ts?(x)';

export const appNodeVitestConfig = {
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: [NODE_TEST_FILES],
    exclude: [
      ...okVitestBase.test.exclude.filter((pattern) => pattern !== NODE_TEST_FILES),
      'public/excalidraw-assets/**',
      '.excalidraw-assets-staging-*',
    ],
    setupFiles: APP_NODE_SETUP_FILES,
    reporters: [...configDefaults.reporters, 'json'],
    outputFile: { json: 'test-results/vitest-node.json' },
  },
} satisfies ViteUserConfig;

export default defineConfig(appNodeVitestConfig);
