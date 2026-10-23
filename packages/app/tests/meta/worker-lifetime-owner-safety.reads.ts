export const ROUND_READS = {
  test: './worker-lifetime-owner-safety.test.ts',
  reads:
    'the owner, subject and observer scripts it starts from the worker-lifetime fixtures, with everything they require',
  roots: [
    'packages/app/tests/foundation/worker-lifetime/process-identity.cjs',
    'packages/app/tests/foundation/worker-lifetime/resource-owner.cjs',
    'packages/app/tests/foundation/worker-lifetime/safety-outer-owner.cjs',
    'packages/app/tests/foundation/worker-lifetime/safety-subject.cjs',
    'packages/app/tests/foundation/worker-lifetime/startup-observer.cjs',
  ],
};
