export const UPDATER_SCAN_ROOT = 'packages/desktop/src/main';
export const ROUND_READS = {
  test: './auto-updater.test.ts',
  reads:
    'every desktop main-process .ts file, tests included, which it scans for UPSTREAM(electron-updater@...) citations; the desktop manifest, whose electron-updater pin it checks; and the CLI manifest, which the suite reads at run time to resolve the CLI package that git-remote.ts imports',
  include: [
    `${UPDATER_SCAN_ROOT}/**/*.ts`,
    'packages/cli/package.json',
    'packages/desktop/package.json',
  ],
};
