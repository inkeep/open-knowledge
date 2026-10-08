export const LOOPBACK_SCAN_ROOTS = ['packages/app/tests/integration', 'packages/app/tests/stress'];

export const ROUND_READS = {
  test: './loopback-bind-discipline.test.ts',
  reads: 'the app integration and stress test sources it scans for listen() binds',
  include: LOOPBACK_SCAN_ROOTS.map((root) => `${root}/**/*.ts`),
};
