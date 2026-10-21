export const ROUND_READS = {
  test: './worker-server-lifetime-ipc.node.test.ts',
  reads: 'the lifetime owner and its closure, and the failing send preload its child loads',
  include: [
    'packages/app/src/build/test-server-startup-contract.ts',
    'packages/app/tests/free-port.test-helper.ts',
    'packages/app/tests/stress/_helpers/seed-key.ts',
    'packages/app/tests/stress/_helpers/server-process.ts',
    'packages/app/tests/stress/_helpers/teardown-fs.ts',
    'packages/app/tests/stress/_helpers/worker-server-command.ts',
    'packages/app/tests/stress/_helpers/worker-server-lifetime.cjs',
    'packages/app/tests/foundation/worker-lifetime/failing-ipc-send.cjs',
  ],
};
