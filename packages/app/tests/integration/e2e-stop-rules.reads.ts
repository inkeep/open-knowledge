import { TEST_ONLY_SOURCE_SUFFIXES } from '../../../../test-support/test-only-source-file.mjs';

export const E2E_SCAN_ROOTS = [
  'packages/app/tests/stress',
  'packages/app/tests/visual',
  'packages/app/tests/a11y',
];
export const APP_SOURCE_ROOT = 'packages/app/src';
export const APP_SOURCE_EXTENSIONS = ['.ts', '.tsx'];
export const APP_SOURCE_EXCLUDED_SUFFIXES = [...TEST_ONLY_SOURCE_SUFFIXES, '.spec.ts', '.spec.tsx'];
export const APP_STYLESHEET = `${APP_SOURCE_ROOT}/globals.css`;

export const ROUND_READS = {
  test: './e2e-stop-rules.test.ts',
  reads: 'the e2e directories and the app source it scans, and the app package.json',
  include: [
    ...E2E_SCAN_ROOTS.map((root) => `${root}/**/*.ts`),
    ...APP_SOURCE_EXTENSIONS.map((extension) => `${APP_SOURCE_ROOT}/**/*${extension}`),
    APP_STYLESHEET,
    'packages/app/package.json',
  ],
  exclude: APP_SOURCE_EXCLUDED_SUFFIXES.map((suffix) => `${APP_SOURCE_ROOT}/**/*${suffix}`),
};
