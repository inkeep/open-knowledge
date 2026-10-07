import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { appBrowserVitestConfig } from '../../../vitest.browser.config';
import { BROWSER_FIXTURE_CACHE_DIR_ENV, BROWSER_FIXTURE_ORDER_ENV } from '../browser-fixture-run';

const APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

class DeclaredOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const order = (process.env[BROWSER_FIXTURE_ORDER_ENV] ?? '').split(',').filter(Boolean);
    const position = (file: TestSpecification): number => {
      const index = order.indexOf(basename(file.moduleId));
      if (index === -1) {
        throw new Error(
          `${basename(file.moduleId)} was selected but is not named in ${BROWSER_FIXTURE_ORDER_ENV}=${order.join(',')}`,
        );
      }
      return index;
    };
    return [...files].sort((left, right) => position(left) - position(right));
  }
}

export const appBrowserFixtureVitestConfig = {
  ...appBrowserVitestConfig,
  root: APP_ROOT,
  cacheDir:
    process.env[BROWSER_FIXTURE_CACHE_DIR_ENV] ??
    join(APP_ROOT, 'node_modules/.vite/browser-fixture'),
  test: {
    ...appBrowserVitestConfig.test,
    include: ['tests/foundation/fixtures/*.fixture.ts?(x)'],
    fileParallelism: false,
    sequence: { sequencer: DeclaredOrderSequencer },
  },
} satisfies ViteUserConfig;

export default defineConfig(appBrowserFixtureVitestConfig);
