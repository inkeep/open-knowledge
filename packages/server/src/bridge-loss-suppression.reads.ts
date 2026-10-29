import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';

export const SERVER_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './bridge-loss-suppression.test.ts',
  reads:
    'every server source .ts file that is neither test-only nor a declaration file, which it scans for paired-write origins, and the test-only predicate it filters by',
  include: [`${SERVER_SCAN_ROOT}/**/*.ts`, 'test-support/test-only-source-file.mjs'],
  exclude: [
    `${SERVER_SCAN_ROOT}/**/*.d.ts`,
    ...TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SERVER_SCAN_ROOT}/**/*${suffix}`),
  ],
};
