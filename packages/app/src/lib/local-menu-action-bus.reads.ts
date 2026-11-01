export const MENU_SCAN_ROOT = 'packages/app/src';
export const ROUND_READS = {
  test: './local-menu-action-bus.test.ts',
  reads:
    'every app source module other than tests and test helpers, which it scans for menu-action emitters',
  include: [`${MENU_SCAN_ROOT}/**/*.{ts,tsx,mts,cts}`],
  exclude: [`${MENU_SCAN_ROOT}/**/*.{test,test-helper}.{ts,tsx,mts,cts}`],
};
