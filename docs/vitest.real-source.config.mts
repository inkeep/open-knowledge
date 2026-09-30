import { fileURLToPath } from 'node:url';
import mdx from 'fumadocs-mdx/vite';
import type { Plugin } from 'vite';
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

// UPSTREAM(fuma-nama/fumadocs#3469): fumadocs-mdx 14.0.x's config hook returns the whole config merged with its additions, so Vite merges every array twice; drop this wrapper once the dependency carries that fix
function withConfigAdditionsOnly(plugin: Plugin): Plugin {
  const addConfig = plugin.config;
  if (typeof addConfig !== 'function') return plugin;
  return {
    ...plugin,
    config(_config, env) {
      return addConfig.call(this, {}, env);
    },
  };
}

export default defineConfig(async () => ({
  ...okVitestBase,
  plugins: [
    ...okVitestBase.plugins,
    withConfigAdditionsOnly(await mdx(Config, { outDir: OUT_DIR })),
    collectionJsonModule,
  ],
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
