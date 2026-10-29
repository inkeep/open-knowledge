export const LOOPBACK_SCAN_ROOT = 'packages/cli/src';
export const ROUND_READS = {
  test: './loopback-bind-discipline.test.ts',
  reads:
    'every CLI unit test, which it scans for listen() calls bound to a loopback host, and the test-only predicate it filters by',
  include: [`${LOOPBACK_SCAN_ROOT}/**/*.test.ts`, 'test-support/test-only-source-file.mjs'],
};
