import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    exclude: [...okVitestBase.test.exclude, '**/*.network.test.ts', '**/dist/**'],
  },
});
