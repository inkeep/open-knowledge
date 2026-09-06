import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../test-support/vitest.base';

const docsRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    css: false,
    server: { deps: { inline: [/fumadocs-ui/] } },
    exclude: [...okVitestBase.test.exclude, '**/*.real-source.test.ts'],
  },
  resolve: {
    ...okVitestBase.resolve,
    alias: [
      { find: /^@\/\.source(?=$|\/)/, replacement: `${docsRoot}.source` },
      { find: /^@\//, replacement: `${docsRoot}src/` },
    ],
  },
});
