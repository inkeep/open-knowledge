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
 * The include adds `**\/*.test.mjs`: the base glob is `**\/*.test.ts?(x)`, which
 * would miss the two native-driver verification tests written as `.mjs`. Both
 * globs together reproduce the file set `bun test` auto-discovered before the
 * flip.
 */
export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: ['**/*.test.ts?(x)', '**/*.test.mjs'],
  },
});
