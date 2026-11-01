import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../../test-support/test-only-source-file.mjs';

export const DISPATCH_SCAN_ROOT = 'packages/app/src';

export const ROUND_READS = {
  test: './dispatch-single-entry-point.test.ts',
  reads:
    'every app source .ts and .tsx file that is not test-only, which it scans for handoff dispatch imports outside the handoff modules, and the test-only predicate it filters by',
  include: [`${DISPATCH_SCAN_ROOT}/**/*.{ts,tsx}`, 'test-support/test-only-source-file.mjs'],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${DISPATCH_SCAN_ROOT}/**/*${suffix}`),
};
