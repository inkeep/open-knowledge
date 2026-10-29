import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const EXHAUSTIVENESS_SCAN_ROOTS = [
  'packages/core/src',
  'packages/server/src',
  'packages/app/src',
];
export const EXHAUSTIVENESS_SCAN_GLOB = '**/*.{ts,tsx}';

export const ROUND_READS = {
  test: './exhaustiveness-coverage.test.ts',
  reads:
    'every core, server and app source .ts and .tsx file that is neither test-only nor a declaration file, which it parses for switches that must cover every problem type, and the test-only predicate it filters them by',
  include: [
    ...EXHAUSTIVENESS_SCAN_ROOTS.map((root) => `${root}/${EXHAUSTIVENESS_SCAN_GLOB}`),
    'test-support/test-only-source-file.mjs',
  ],
  exclude: EXHAUSTIVENESS_SCAN_ROOTS.flatMap((root) => [
    `${root}/**/*.d.ts`,
    ...TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${root}/**/*${suffix}`),
  ]),
};
