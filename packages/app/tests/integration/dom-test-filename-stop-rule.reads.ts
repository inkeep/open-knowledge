export const DOM_TEST_SCAN_ROOTS = ['src', 'tests'];
export const DOM_TEST_SCAN_GLOB = '**/*.test.tsx';

export const ROUND_READS = {
  test: './dom-test-filename-stop-rule.test.ts',
  reads:
    'every app .test.tsx file under src and tests, which it checks so that every DOM-tier test imports @testing-library/react and no test outside the DOM and browser tiers does',
  include: DOM_TEST_SCAN_ROOTS.map((root) => `packages/app/${root}/${DOM_TEST_SCAN_GLOB}`),
};
