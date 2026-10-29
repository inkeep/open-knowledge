import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../../test-support/test-only-source-file.mjs';

export const SOURCE_POLISH_SCAN_ROOT = 'packages/app/src/editor/source-polish';

export const ROUND_READS = {
  test: './engine-invariants.test.ts',
  reads:
    'the source-polish modules beside it that are not test-only, which it checks for the engine invariants, and the test-only predicate it filters by',
  include: [`${SOURCE_POLISH_SCAN_ROOT}/*.{ts,tsx}`, 'test-support/test-only-source-file.mjs'],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SOURCE_POLISH_SCAN_ROOT}/*${suffix}`),
};
