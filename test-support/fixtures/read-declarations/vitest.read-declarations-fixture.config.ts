import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    globals: true,
    include: ['*.guard.test.mjs'],
    maxWorkers: 1,
  },
});
