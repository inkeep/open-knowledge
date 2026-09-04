import { fileURLToPath } from 'node:url';
import mdx from 'fumadocs-mdx/vite';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../test-support/vitest.base';
import * as Config from './source.config.ts';

const docsRoot = fileURLToPath(new URL('.', import.meta.url));

const OUT_DIR = '.source-vitest';

const collectionJsonModule = {
  name: 'docs-collection-json-module',
  enforce: 'post' as const,
  transform(code: string, id: string) {
    if (!/\.json\?collection=/.test(id)) return null;
    if (!code.trimStart().startsWith('{')) return null;
    return { code: `export default ${code};`, map: null };
  },
};

export default defineConfig(async () => ({
  ...okVitestBase,
  plugins: [...okVitestBase.plugins, await mdx(Config, { outDir: OUT_DIR }), collectionJsonModule],
  test: {
    ...okVitestBase.test,
    include: ['src/**/*.real-source.test.ts'],
    css: false,
    server: { deps: { inline: [/fumadocs-ui/] } },
  },
  resolve: {
    ...okVitestBase.resolve,
    alias: [
      { find: /(?:\.\.\/)+\.source(?=$|\/)/, replacement: `${docsRoot}${OUT_DIR}` },
      { find: /^@\/\.source(?=$|\/)/, replacement: `${docsRoot}${OUT_DIR}` },
      { find: /^@\//, replacement: `${docsRoot}src/` },
    ],
  },
}));
