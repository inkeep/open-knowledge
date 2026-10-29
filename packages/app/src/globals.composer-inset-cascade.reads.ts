export const COMPOSER_SCAN_ROOT = 'packages/app/src';
export const ROUND_READS = {
  test: './globals.composer-inset-cascade.test.ts',
  reads:
    'every app source script and stylesheet other than tests, test helpers and locales, which it scans for full-page editor surfaces and the composer inset',
  include: [`${COMPOSER_SCAN_ROOT}/**/*.{ts,tsx,js,jsx,css}`],
  exclude: [
    `${COMPOSER_SCAN_ROOT}/**/*.{test,test-helper}.{ts,tsx,js,jsx}`,
    `${COMPOSER_SCAN_ROOT}/locales/**`,
  ],
};
