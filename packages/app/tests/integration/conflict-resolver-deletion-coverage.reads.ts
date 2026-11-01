import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const RESOLVER_SCAN_ROOT = 'packages/app/src';
export const RESOLVER_SCAN_EXTENSIONS = ['.ts', '.tsx'];

export const ROUND_READS = {
  test: './conflict-resolver-deletion-coverage.test.ts',
  reads:
    'every app source .ts and .tsx file that is not test-only, which it scans for references to the deleted ConflictResolver, a recreated one included, and the test-only predicate it filters by',
  include: [
    'test-support/test-only-source-file.mjs',
    `${RESOLVER_SCAN_ROOT}/**/*.{${RESOLVER_SCAN_EXTENSIONS.map((extension) => extension.slice(1)).join(',')}}`,
  ],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${RESOLVER_SCAN_ROOT}/**/*${suffix}`),
};
