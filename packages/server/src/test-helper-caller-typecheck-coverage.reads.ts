export const CALLER_SUFFIX = '.test.ts';
export const HELPER_SUFFIX = '.test-helper.ts';
export const CALLERS_TSCONFIG = 'tsconfig.test-helper-callers.json';

export const SERVER_DIR = 'packages/server';

export const ROUND_READS = {
  test: './test-helper-caller-typecheck-coverage.test.ts',
  reads:
    'every server test and shared test helper it scans, the callers tsconfig, and the server package.json',
  include: [
    `${SERVER_DIR}/**/*${CALLER_SUFFIX}`,
    `${SERVER_DIR}/**/*${HELPER_SUFFIX}`,
    `${SERVER_DIR}/${CALLERS_TSCONFIG}`,
    `${SERVER_DIR}/package.json`,
  ],
};
