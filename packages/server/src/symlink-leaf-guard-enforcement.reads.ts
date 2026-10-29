import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';

export const SERVER_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './symlink-leaf-guard-enforcement.test.ts',
  reads:
    'every server source .ts file that is not test-only, which it scans for leaf-path writes and their symlink checks, and the test-only predicate it filters by',
  include: [`${SERVER_SCAN_ROOT}/**/*.ts`, 'test-support/test-only-source-file.mjs'],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SERVER_SCAN_ROOT}/**/*${suffix}`),
};
