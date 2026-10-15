import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from './test-support/vitest.base';

const serverAuthorityRegistrySetup = fileURLToPath(
  new URL('./test-support/server-authority-registry.setup.ts', import.meta.url),
);

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    setupFiles: [...okVitestBase.test.setupFiles, serverAuthorityRegistrySetup],
    include: [
      'scripts/**/*.test.mjs',
      '.github/scripts/**/*.test.mjs',
      'lint-plugins/**/*.test.mjs',
      'plugins/**/*.test.mjs',
      'test-support/**/*.test.ts',
      'test-support/**/*.test.mjs',
      'tests/**/*.test.ts',
    ],
    exclude: [...okVitestBase.test.exclude, 'plugins/**/scripts/*.test.mjs'],
  },
});
