import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import serverConfig from './packages/server/vitest.config';
import { UNCACHED_TEST_GLOBS } from './test-support/uncached-tier';
import scriptsConfig from './vitest.scripts.config';

const SOURCES = [
  { name: 'packages/server/vitest.config.ts', dir: 'packages/server', config: serverConfig },
  { name: 'vitest.scripts.config.ts', dir: '.', config: scriptsConfig },
];

const reconcile = fileURLToPath(
  new URL('./test-support/uncached-tier-reconcile.ts', import.meta.url),
);

export default defineConfig({
  test: {
    projects: SOURCES.map(({ name, dir, config }) => {
      const include = config.test?.include ?? [];
      const exclude = config.test?.exclude ?? [];
      const missing = UNCACHED_TEST_GLOBS.filter((glob) => !exclude.includes(glob));
      if (missing.length > 0) {
        throw new Error(
          `vitest.uncached.config.ts: ${name} does not exclude ${missing.join(', ')}, so its cached tier would run the suffixed files too and could replay a stale pass. Spread okVitestBase.test.exclude into its exclude.`,
        );
      }
      const suffixed = include.map((glob) => glob.replace(/\.test\.(?=[^/]*$)/, '.uncached.test.'));
      const unsuffixed = suffixed.filter((glob) => !glob.includes('.uncached.test.'));
      if (unsuffixed.length > 0) {
        throw new Error(
          `vitest.uncached.config.ts: ${name} includes ${unsuffixed.join(', ')}, which names no .test. segment, so the tier cannot derive the suffixed form of it. Name test files by their .test. segment in that include.`,
        );
      }
      const globalSetup = config.test?.globalSetup ?? [];
      return {
        ...config,
        root: fileURLToPath(new URL(`./${dir}/`, import.meta.url)),
        test: {
          ...config.test,
          name,
          include: suffixed,
          exclude: exclude.filter((glob) => !UNCACHED_TEST_GLOBS.includes(glob)),
          globalSetup: [reconcile, ...(Array.isArray(globalSetup) ? globalSetup : [globalSetup])],
        },
      };
    }),
  },
});
