import { defineConfig } from 'vitest/config';
import { okVitestBase } from './test-support/vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: [
      'scripts/**/*.test.mjs',
      '.github/scripts/**/*.test.mjs',
      'lint-plugins/**/*.test.mjs',
      'plugins/**/*.test.mjs',
      'test-support/**/*.test.ts',
      'test-support/**/*.test.mjs',
    ],
  },
});
