export const ROUND_READS = {
  test: './warm-cache-owner-loss.node.test.ts',
  reads:
    "the warm-cache spawn, its owner guard, the holder and the observation preload the test starts in child processes, with everything they import, then what those processes read at run time: the core source the holder loads through @inkeep/open-knowledge-core, the seed-key inputs (the lockfile and the app's Vite config files and package.json), the app and root tsconfig.json, the root package.json the pnpm launcher reads, the app's predev script, the read observer each Node child preloads, and what the warm Vite build reads before owner loss ends it, which a later owner loss widens to a full start's app, core and server packages, project config and root package.json",
  roots: [
    'packages/app/tests/stress/_helpers/global-warm-cache.ts',
    'packages/app/tests/stress/_helpers/warm-cache-owner-guard.cjs',
    'packages/app/tests/stress/_helpers/warm-cache-owner-loss-holder.mjs',
    'packages/app/tests/stress/_helpers/warm-cache-owner-loss-guard.cjs',
  ],
  include: [
    'packages/app/**',
    'packages/core/**',
    'packages/server/**',
    'test-support/read-declarations-observer.ts',
    'pnpm-lock.yaml',
    '.ok/config.yml',
    'package.json',
    'tsconfig.json',
  ],
};
