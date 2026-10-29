export const RENDERER_SCAN_ROOT = 'packages/app/src';
export const RENDERER_SCAN_GLOB = '**/*.{ts,tsx}';

export const ROUND_READS = {
  test: './y-prosemirror-import-coverage.test.ts',
  reads:
    'every .ts and .tsx file under the app source, tests included, which it scans for y-prosemirror imports',
  include: [`${RENDERER_SCAN_ROOT}/${RENDERER_SCAN_GLOB}`],
  exclude: [`${RENDERER_SCAN_ROOT}/**/*.d.ts`],
};
