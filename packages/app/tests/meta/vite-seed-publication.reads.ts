export const ROUND_READS = {
  test: './vite-seed-publication.test.ts',
  reads:
    'the warm-seed race harness, the stress helpers it runs and the owner lifeline it runs under, then what its two warm builds read: the app, core and server packages the Vite dev server loads, the test-support modules its child processes load, the lockfile, the project config and the root package.json',
  include: [
    'packages/app/**',
    'packages/core/**',
    'packages/server/**',
    'test-support/**',
    'pnpm-lock.yaml',
    '.ok/config.yml',
    'package.json',
  ],
};
