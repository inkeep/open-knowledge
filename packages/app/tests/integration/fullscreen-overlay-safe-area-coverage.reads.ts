import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const OVERLAY_SCAN_ROOT = 'packages/app/src';
export const OVERLAY_SCAN_EXTENSION = '.tsx';

export const ROUND_READS = {
  test: './fullscreen-overlay-safe-area-coverage.test.ts',
  reads:
    'every app source .tsx file that is not test-only, which it scans for full-viewport overlay classes, and the test-only predicate it filters by',
  include: [
    `${OVERLAY_SCAN_ROOT}/**/*${OVERLAY_SCAN_EXTENSION}`,
    'test-support/test-only-source-file.mjs',
  ],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${OVERLAY_SCAN_ROOT}/**/*${suffix}`),
};
