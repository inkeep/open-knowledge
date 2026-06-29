import { resolve } from 'node:path';
import babel from '@rolldown/plugin-babel';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { injectAppVersionEnv } from '../app/src/build/app-version';
import { chromeTokensVitePlugin } from '../app/src/build/chrome-tokens-vite-plugin';
import { RENDERER_DEDUPE } from '../app/vite.dedupe';
import { RENDERER_BABEL_OPTIONS } from '../app/vite.react-babel';

injectAppVersionEnv();


const appRoot = resolve(__dirname, '../app');

process.env.LINGUI_CONFIG ??= resolve(appRoot, 'lingui.config.ts');

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      sourcemap: 'hidden',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'utility/server-entry': resolve(__dirname, 'src/utility/server-entry.ts'),
          'utility/pty-host': resolve(__dirname, 'src/utility/pty-host.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
    resolve: {
      alias: {
        '@/shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      sourcemap: 'hidden',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: appRoot,
    plugins: [
      chromeTokensVitePlugin({ globalsCssPath: resolve(appRoot, 'src/globals.css') }),
      react(),
      await babel(RENDERER_BABEL_OPTIONS),
    ],
    resolve: {
      alias: {
        '@': resolve(appRoot, 'src'),
      },
      dedupe: [...RENDERER_DEDUPE],
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      sourcemap: 'hidden',
      rollupOptions: {
        input: resolve(appRoot, 'index.html'),
      },
    },
    server: {
      watch: {
        ignored: ['**/content/**'],
      },
    },
  },
});
