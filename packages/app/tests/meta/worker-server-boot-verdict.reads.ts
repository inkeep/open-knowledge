export const ROUND_READS = {
  test: './worker-server-boot-verdict.test.ts',
  reads:
    'the nested Playwright config and cases with everything they import, the reporter the config names, the worker-server owner the fixture starts, and the package and TypeScript configuration its loader reads',
  roots: [
    'packages/app/tests/stress/_helpers/boot-verdict/**',
    'packages/app/tests/stress/_helpers/setup-non-result-reporter.ts',
    'packages/app/tests/stress/_helpers/worker-server-lifetime.cjs',
  ],
  include: [
    'packages/app/package.json',
    'packages/app/tsconfig.json',
    'packages/core/tsconfig.json',
    'tsconfig.json',
  ],
};
