import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

/**
 * Vitest config for packages/desktop.
 *
 * Spreads the shared workspace base (`development` export-condition pin,
 * `bun:test` alias shim, `Bun` global facade, `import.meta.dir` transform, 30s
 * timeout, node environment). Desktop tests exercise the Electron main /
 * utility processes and never touch a DOM, so the base `node` environment is
 * correct — no jsdom project.
 *
 * The include adds `**\/*.test.mjs`: the base glob is `**\/*.test.ts?(x)`, so
 * on its own it would miss any suite written as `.mjs` — e.g. the guards that
 * import a plain `.mjs` driver directly rather than through TypeScript.
 * Keep the glob broad: narrowing it to match today's filenames would
 * un-discover the next one silently, with vitest reporting fewer tests and no
 * error.
 */
export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: ['**/*.test.ts?(x)', '**/*.test.mjs'],
  },
});
