import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../test-support/vitest.base';

const docsRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  ...okVitestBase,
  resolve: {
    ...okVitestBase.resolve,
    alias: [
      { find: /^@\/\.source(?=$|\/)/, replacement: `${docsRoot}.source` },
      { find: /^@\//, replacement: `${docsRoot}src/` },
    ],
  },
});
