export const MOCK_SCAN_SOURCE_DIR = 'src';
export const MOCK_SCAN_GLOB = '**/*.test.{ts,tsx}';

const SOURCE_ROOT = `packages/app/${MOCK_SCAN_SOURCE_DIR}`;

export const ROUND_READS = {
  test: './mock-module-completeness.test.ts',
  reads:
    'every app source test file outside the DOM tier, which it scans for vi.doMock factories, and the test-only predicate it filters by',
  include: [`${SOURCE_ROOT}/${MOCK_SCAN_GLOB}`, 'test-support/test-only-source-file.mjs'],
  exclude: [`${SOURCE_ROOT}/**/*.dom.test.{ts,tsx}`],
};
