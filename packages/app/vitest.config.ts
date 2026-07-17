import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { bunGlobalShimPath, bunTestShimPath, okVitestBase } from '../../test-support/vitest.base';
import { RENDERER_DEDUPE } from './vite.dedupe';

// `@lingui/{react,core}/macro` only run under the build's Babel macro pass; a
// plain transpile leaves the specifiers pointing at modules that throw
// ("Cannot find package 'babel-plugin-macros'") the moment they load. The bun
// test runner sidestepped this with a `[test] preload` resolver that redirects
// both macro specifiers to an English-passthrough runtime shim
// (`tests/lingui-macro-shim.tsx`); the same shim is what the real macro renders
// once the `en` catalog is active, so component behaviour tests stay valid.
// Replicated here as a resolve alias so the vitest transform sees the shim, not
// the macro entrypoints — a byte-faithful stand-in for the retired preload.
const linguiMacroShim = fileURLToPath(new URL('./tests/lingui-macro-shim.tsx', import.meta.url));
const srcDir = fileURLToPath(new URL('./src/', import.meta.url));

// Global per-test IDB reset, ported from the bun `[test] preload`. Installs
// `fake-indexeddb` and wipes every `ok-ydoc:` database after each test so
// shared doc names do not hydrate from prior-test state.
const idbPreloadPath = fileURLToPath(
  new URL('./tests/integration/idb-preload.ts', import.meta.url),
);

export const appVitestConfig = {
  ...okVitestBase,
  plugins: [...okVitestBase.plugins, react()],
  resolve: {
    ...okVitestBase.resolve,
    alias: [
      { find: 'bun:test', replacement: bunTestShimPath },
      { find: '@lingui/react/macro', replacement: linguiMacroShim },
      { find: '@lingui/core/macro', replacement: linguiMacroShim },
      { find: /^@\//, replacement: srcDir },
    ],
    // Single-instance resolution for React/Yjs/ProseMirror/CodeMirror — the
    // same list the renderer build dedupes. Multiple physical copies break
    // `instanceof` checks and Yjs's constructor-identity guard.
    dedupe: [...RENDERER_DEDUPE],
  },
  test: {
    ...okVitestBase.test,
    setupFiles: [bunGlobalShimPath, idbPreloadPath],
  },
} satisfies ViteUserConfig;

export default defineConfig(appVitestConfig);
