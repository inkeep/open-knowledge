export const CV_SCAN_ROOT = 'packages/app/src';
export const ROUND_READS = {
  test: './globals.cv-paint-lock.test.ts',
  reads:
    'every .ts, .tsx and .css file under the app source, tests included, which it scans for content-visibility: hidden',
  include: [`${CV_SCAN_ROOT}/**/*.{ts,tsx,css}`],
};
