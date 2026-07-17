import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { bunTestShimPath, okVitestBase } from '../test-support/vitest.base';

/**
 * Vitest config for the docs (Next.js) package.
 *
 * Spreads the shared workspace base but replaces the alias map: docs route
 * tests resolve `@/…` against `docs/src` (and `@/.source` against the generated
 * fumadocs content), matching the Next.js `paths` in `docs/tsconfig.json`. The
 * base's object-form alias only carries `bun:test`, so it is re-added here as
 * the first array entry (array form is required to express the ordered `@`
 * prefixes — `.source` must win before the general `@/` rule).
 */
const docsRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  ...okVitestBase,
  resolve: {
    ...okVitestBase.resolve,
    alias: [
      { find: 'bun:test', replacement: bunTestShimPath },
      { find: /^@\/\.source(?=$|\/)/, replacement: `${docsRoot}.source` },
      { find: /^@\//, replacement: `${docsRoot}src/` },
    ],
  },
});
