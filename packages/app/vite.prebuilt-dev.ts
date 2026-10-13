import { isAbsolute, resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import {
  E2E_PAGE_MODULES_CHUNK,
  E2E_PAGE_MODULES_SOURCE,
  PREBUILT_MODULE_MANIFEST,
  PREBUILT_OUT_DIR_ENV,
  PREBUILT_OUTPUT_OPTIONS,
} from './src/build/prebuilt-dev-contract';
import { prebuiltModuleChunksPlugin } from './src/build/prebuilt-module-chunks-plugin';
import { prebuiltHocuspocusPlugin } from './src/server/hocuspocus-plugin';
import base from './vite.config';
import { rendererHtmlInput } from './vite.entries';

const outDir = process.env[PREBUILT_OUT_DIR_ENV];
if (outDir === undefined || !isAbsolute(outDir)) {
  throw new Error(`${PREBUILT_OUT_DIR_ENV} must name the prebuilt DEV app's absolute directory`);
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [prebuiltHocuspocusPlugin(), prebuiltModuleChunksPlugin(import.meta.dirname)],
    build: {
      outDir,
      emptyOutDir: true,
      manifest: PREBUILT_MODULE_MANIFEST,
      rolldownOptions: {
        input: {
          ...rendererHtmlInput(import.meta.dirname),
          [E2E_PAGE_MODULES_CHUNK]: resolve(import.meta.dirname, E2E_PAGE_MODULES_SOURCE),
        },
        preserveEntrySignatures: 'exports-only',
        output: PREBUILT_OUTPUT_OPTIONS,
      },
    },
    preview: { port: base.server?.port, strictPort: base.server?.strictPort },
  }),
);
