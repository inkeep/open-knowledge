import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../test-support/test-only-source-file.mjs';

export const SERVER_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './agent-write-agent-id-coverage.test.ts',
  reads:
    'every server source .ts and .tsx file that is not test-only, from which it lists the agent-write spine files it parses; the package manifest its parser reads to resolve imports; and the test-only predicate it filters by',
  include: [
    `${SERVER_SCAN_ROOT}/**/*.{ts,tsx}`,
    'packages/server/package.json',
    'test-support/test-only-source-file.mjs',
  ],
  exclude: TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${SERVER_SCAN_ROOT}/**/*${suffix}`),
};
