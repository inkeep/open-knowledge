import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const SYNC_SCAN_ROOT = 'packages/app/src';
export const SYNC_SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

export const ROUND_READS = {
  test: './no-sync-set-enabled-references.test.ts',
  reads:
    'every app source .ts, .tsx, .js and .mjs file that is not test-only, which it scans for /api/sync/set-enabled references, and the test-only predicate it filters by',
  include: [
    'test-support/test-only-source-file.mjs',
    `${SYNC_SCAN_ROOT}/**/*.{${SYNC_SCAN_EXTENSIONS.map((extension) => extension.slice(1)).join(',')}}`,
  ],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SYNC_SCAN_ROOT}/**/*${suffix}`),
};
