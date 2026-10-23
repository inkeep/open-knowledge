export const ROUND_READS = {
  test: './ownership-run-config.node.test.ts',
  reads:
    'the nested ownership config, its lifetime case, global setup, reporter, preloads and the server script they start, with everything they import, and the package and TypeScript configuration its loader reads',
  roots: [
    'packages/app/tests/stress/_helpers/port-ownership/ownership-run.config.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime.ownership-case.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime-global-setup.ts',
    'packages/app/tests/stress/_helpers/port-ownership/lifetime-server.cjs',
    'packages/app/tests/stress/_helpers/port-ownership/occupy-selected-port.cjs',
    'packages/app/tests/stress/_helpers/port-ownership/owner-scratch-janitor.cjs',
    'packages/app/tests/stress/_helpers/setup-non-result-reporter.ts',
  ],
  include: ['packages/app/package.json', 'packages/app/tsconfig.json', 'tsconfig.json'],
};
