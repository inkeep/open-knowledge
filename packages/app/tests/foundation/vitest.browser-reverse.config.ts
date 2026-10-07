import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { appBrowserVitestConfig } from '../../vitest.browser.config';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));

class DescendingPathSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((left, right) => {
      if (left.moduleId < right.moduleId) return 1;
      return left.moduleId > right.moduleId ? -1 : 0;
    });
  }
}

export const appBrowserReverseVitestConfig = {
  ...appBrowserVitestConfig,
  root: APP_ROOT,
  test: {
    ...appBrowserVitestConfig.test,
    fileParallelism: false,
    sequence: { sequencer: DescendingPathSequencer },
  },
} satisfies ViteUserConfig;

export default defineConfig(appBrowserReverseVitestConfig);
