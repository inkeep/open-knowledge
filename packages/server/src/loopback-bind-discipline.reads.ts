export const LOOPBACK_SCAN_ROOT = 'packages/server/src';

export const ROUND_READS = {
  test: './loopback-bind-discipline.test.ts',
  reads:
    'every server unit test, which it scans for listen() calls bound to a loopback host, and the test-only predicate it selects them by',
  include: [`${LOOPBACK_SCAN_ROOT}/**/*.test.ts`, 'test-support/test-only-source-file.mjs'],
};
