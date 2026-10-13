import type { Rolldown } from 'vite';

export const PREBUILT_OUT_DIR_ENV = 'OK_TEST_PREBUILT_OUT_DIR';

export const PREBUILT_MODULE_MANIFEST = '.vite/manifest.json';

export const E2E_PAGE_MODULES_CHUNK = 'e2e-page-modules';

export const E2E_PAGE_MODULES_SOURCE = 'src/test-utils/e2e-page-modules.ts';

export const PREBUILT_MODULE_CHUNKS = '.vite/module-chunks.json';

export const PREBUILT_OUTPUT_OPTIONS = {
  keepNames: true,
} as const satisfies Rolldown.OutputOptions;
