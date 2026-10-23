export const ROUND_READS = {
  test: './worker-server-lifetime-ipc.node.test.ts',
  reads:
    'the lifetime owner it starts, with everything the owner requires, and the failing send preload its child loads',
  roots: [
    'packages/app/tests/stress/_helpers/worker-server-lifetime.cjs',
    'packages/app/tests/foundation/worker-lifetime/failing-ipc-send.cjs',
  ],
};
