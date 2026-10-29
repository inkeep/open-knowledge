import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';

export const SERVER_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './console-discipline.test.ts',
  reads:
    'every server source .ts file that is not test-only, which it scans for raw console calls, and the test-only predicate it filters them by',
  include: [`${SERVER_SCAN_ROOT}/**/*.ts`, 'test-support/test-only-source-file.mjs'],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SERVER_SCAN_ROOT}/**/*${suffix}`),
};
