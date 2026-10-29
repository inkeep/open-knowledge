export const SERVER_SCAN_ROOT = 'packages/server/src';
export const ROUND_READS = {
  test: './child-process-windows-hide.test.ts',
  reads:
    'every server source .ts file it parses for child-process spawns and the test helpers they import; the server and core package manifests and the declaration file its parser reads to resolve imports; and the test-only predicate it filters by',
  include: [
    'test-support/test-only-source-file.mjs',
    `${SERVER_SCAN_ROOT}/**/*.ts`,
    'packages/server/package.json',
    'packages/core/package.json',
    'test-support/test-only-source-file.d.mts',
  ],
  exclude: [`${SERVER_SCAN_ROOT}/**/*.test.ts`],
};
