import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: ['test-support/fixtures/no-net-connect/no-net-connect.fixture.ts'],
    maxWorkers: 1,
  },
});
