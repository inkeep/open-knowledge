import { fileURLToPath } from 'node:url';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';
import { babelOutputCache } from './tests/foundation/babel-output-cache';
import {
  BROWSER_OPTIMIZE_DEPS_INCLUDE,
  dependencyReloadGuard,
} from './tests/foundation/browser-dependency-optimizer';
import { runBrowserFixture } from './tests/foundation/browser-fixture-command';
import { withMockContracts } from './tests/foundation/browser-mock-provider';
import {
  installNetworkGuard,
  takeBlockedNetworkRequests,
} from './tests/foundation/browser-network-guard';
import {
  BROWSER_PRODUCT_MODULE_EXCLUDES,
  BROWSER_TEST_MODULES,
  browserCiValue,
  browserNodeSubstitutes,
  NODE_MODULES,
} from './tests/foundation/browser-node-compat';
import { buildAppStylesheet } from './tests/foundation/build-app-stylesheet';
import { chromiumGcLaunchEnvGuard } from './tests/foundation/chromium-gc-launch-env';
import { RENDERER_DEDUPE } from './vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from './vite.react-babel';

const srcDir = fileURLToPath(new URL('./src/', import.meta.url));

const BROWSER_FILE_BRIDGE_ROOTS = [
  srcDir,
  fileURLToPath(new URL('./tests/', import.meta.url)),
  fileURLToPath(new URL('../../test-support/', import.meta.url)),
];

export const APP_BROWSER_BABEL_OUTPUT = babelOutputCache();

export function appBrowserBabelPasses() {
  return [
    babel({ ...RENDERER_BABEL_OPTIONS, exclude: [...BROWSER_PRODUCT_MODULE_EXCLUDES] }),
    babel({
      plugins: RENDERER_BABEL_OPTIONS.plugins,
      include: [...BROWSER_TEST_MODULES],
      exclude: [NODE_MODULES],
    }),
  ];
}

export const APP_BROWSER_SETUP_FILES = [
  fileURLToPath(new URL('./tests/foundation/browser-setup.ts', import.meta.url)),
];

const BROWSER_TEST_FILES = '**/*.browser.test.ts?(x)';

export const appBrowserVitestConfig = {
  plugins: [
    ...okVitestBase.plugins,
    chromiumGcLaunchEnvGuard(),
    dependencyReloadGuard(),
    browserCiValue(process.env),
    browserNodeSubstitutes(BROWSER_FILE_BRIDGE_ROOTS),
    react(),
    ...appBrowserBabelPasses().map((pass, index) => APP_BROWSER_BABEL_OUTPUT.wrap(pass, index)),
  ],
  resolve: {
    conditions: ['module', 'browser', 'development'],
    alias: [{ find: /^@\//, replacement: srcDir }],
    dedupe: [...RENDERER_DEDUPE],
  },
  optimizeDeps: { force: true, include: [...BROWSER_OPTIMIZE_DEPS_INCLUDE] },
  test: {
    testTimeout: okVitestBase.test.testTimeout,
    hookTimeout: okVitestBase.test.hookTimeout,
    env: okVitestBase.test.env,
    clearMocks: okVitestBase.test.clearMocks,
    expect: okVitestBase.test.expect,
    tags: okVitestBase.test.tags,
    include: [BROWSER_TEST_FILES],
    exclude: [
      ...okVitestBase.test.exclude.filter((pattern) => pattern !== BROWSER_TEST_FILES),
      'public/excalidraw-assets/**',
      '.excalidraw-assets-staging-*',
    ],
    setupFiles: APP_BROWSER_SETUP_FILES,
    globalSetup: [fileURLToPath(new URL('./scripts/compile-i18n-catalogs.ts', import.meta.url))],
    reporters: [...configDefaults.reporters, 'json'],
    outputFile: { json: 'test-results/vitest-browser.json' },
    isolate: true,
    browser: {
      enabled: true,
      provider: withMockContracts(playwright()),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: 'chromium' }],
      commands: {
        runBrowserFixture,
        installNetworkGuard,
        takeBlockedNetworkRequests,
        buildAppStylesheet,
      },
    },
  },
} satisfies ViteUserConfig;

export default defineConfig(appBrowserVitestConfig);
