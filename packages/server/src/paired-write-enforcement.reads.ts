import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';

export const SERVER_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './paired-write-enforcement.test.ts',
  reads:
    'every server source .ts file that is neither test-only nor a declaration file, which it parses for paired writes and their transactions; the package manifest its parser reads to resolve imports; and the test-only predicate it filters by',
  include: [
    `${SERVER_SCAN_ROOT}/**/*.ts`,
    'packages/server/package.json',
    'test-support/test-only-source-file.mjs',
  ],
  exclude: [
    `${SERVER_SCAN_ROOT}/**/*.d.ts`,
    ...TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SERVER_SCAN_ROOT}/**/*${suffix}`),
  ],
};
