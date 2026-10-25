export const ROUND_READS = {
  test: './worker-server-lifetime-diagnostics.node.test.ts',
  reads:
    "the lifetime owner and the CLI source entry the test starts, with everything they import, then what those processes read at run time: the server package manifest the server source reads for its version, and the worker fixtures module the test process reads when it imports the setup failure report's log tail",
  roots: [
    'packages/app/tests/stress/_helpers/worker-server-lifetime.cjs',
    'packages/cli/src/cli.ts',
  ],
  include: ['packages/app/tests/stress/_helpers/fixtures.ts', 'packages/server/package.json'],
};
