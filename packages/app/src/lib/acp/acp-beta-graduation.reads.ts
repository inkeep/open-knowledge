export const ACP_SCAN_APP_ROOT = 'packages/app';
export const ACP_SCAN_SOURCE_DIR = 'src';
export const ACP_SCAN_LOCALES_DIR = 'src/locales';

export const ROUND_READS = {
  test: './acp-beta-graduation.test.ts',
  reads:
    'every app source .ts and .tsx file other than tests, e2e specs and stories, which it searches for the beta strings, the source locale catalogs, and the Lingui config and package manifests its message reader loads',
  include: [
    `${ACP_SCAN_APP_ROOT}/${ACP_SCAN_SOURCE_DIR}/**/*.{ts,tsx}`,
    `${ACP_SCAN_APP_ROOT}/${ACP_SCAN_LOCALES_DIR}/*/messages.po`,
    `${ACP_SCAN_APP_ROOT}/lingui.config.ts`,
    `${ACP_SCAN_APP_ROOT}/package.json`,
    'package.json',
  ],
  exclude: [`${ACP_SCAN_APP_ROOT}/${ACP_SCAN_SOURCE_DIR}/**/*.{test,e2e,stories}.*`],
};
