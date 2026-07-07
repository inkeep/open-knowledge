/**
 * Bun-test preload: replace the Lingui macro entrypoints with a runtime shim.
 *
 * `bun test` transpiles TSX natively but runs no Babel plugins, so the Lingui
 * macro never transforms — and the real `@lingui/{react,core}/macro` modules
 * only export `printError` stubs (and import `babel-plugin-macros`, which is
 * not installed). This resolver plugin redirects those specifiers to
 * `lingui-macro-shim.tsx`, an English-passthrough stand-in.
 *
 * Registered via `[test] preload` in `packages/app/bunfig.toml`.
 */

import { resolve } from 'node:path';
import { plugin } from 'bun';

const shimPath = resolve(import.meta.dir, 'lingui-macro-shim.tsx');

plugin({
  name: 'lingui-macro-test-shim',
  setup(build) {
    // Redirect the bare macro specifiers to the shim.
    build.onResolve({ filter: /^@lingui\/(react|core)\/macro$/ }, () => ({ path: shimPath }));
    // Belt-and-suspenders: if a macro module is reached by resolved path
    // (e.g. a deep import), serve a re-export of the shim instead.
    build.onLoad({ filter: /@lingui[\\/](react|core)[\\/]macro[\\/]/ }, () => ({
      contents: `export * from ${JSON.stringify(shimPath)};`,
      loader: 'js',
    }));
  },
});
