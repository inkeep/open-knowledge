export const HOOK_TIMEOUT_SCAN_DIRS = ['tests/integration', 'tests/conversion'];

export const ROUND_READS = {
  test: './hook-timeout-stop-rules.test.ts',
  reads:
    'every app integration and conversion unit test, which it parses for beforeAll hooks without a timeout, and the test-only predicate it selects them by',
  include: [
    ...HOOK_TIMEOUT_SCAN_DIRS.map((dir) => `packages/app/${dir}/**/*.test.ts`),
    'test-support/test-only-source-file.mjs',
  ],
};
