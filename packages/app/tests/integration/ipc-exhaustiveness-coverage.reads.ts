import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const IPC_SCAN_ROOTS = ['packages/core/src', 'packages/app/src'];
export const IPC_SCAN_GLOB = '**/*.{ts,tsx}';

export const ROUND_READS = {
  test: './ipc-exhaustiveness-coverage.test.ts',
  reads:
    'every core and app source .ts and .tsx file that is neither test-only nor a declaration file, which it parses for switches over IPC unions, and the test-only predicate it filters by',
  include: [
    ...IPC_SCAN_ROOTS.map((root) => `${root}/${IPC_SCAN_GLOB}`),
    'test-support/test-only-source-file.mjs',
  ],
  exclude: IPC_SCAN_ROOTS.flatMap((root) => [
    `${root}/**/*.d.ts`,
    ...TEST_ONLY_SOURCE_SUFFIXES.map((suffix) => `${root}/**/*${suffix}`),
  ]),
};
