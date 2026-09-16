import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: ['src/acp/*.network.test.ts'],
    fileParallelism: false,
  },
});
