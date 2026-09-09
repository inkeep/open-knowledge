import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, type Plugin, type ViteUserConfig } from 'vitest/config';

const cpuCount = availableParallelism();
const boundedMaxForks =
  !process.env.CI && cpuCount >= 8 ? Math.max(1, Math.floor(cpuCount / 4)) : undefined;

const IMPORT_META_DIR = /import\.meta\.dir(?![\w$])/g;

export const importMetaDirPlugin: Plugin = {
  name: 'ok-bun-import-meta-dir',
  enforce: 'pre',
  transform(code: string) {
    if (!code.includes('import.meta')) return null;
    IMPORT_META_DIR.lastIndex = 0;
    const out = code.replace(IMPORT_META_DIR, 'import.meta.dirname');
    return out === code ? null : { code: out, map: null };
  },
};

const bunGlobalShimPath = fileURLToPath(new URL('./bun-global-shim.ts', import.meta.url));

const noNetConnectPath = fileURLToPath(new URL('./no-net-connect.ts', import.meta.url));

export const okVitestBase = {
  plugins: [importMetaDirPlugin],
  resolve: {
    conditions: ['development'],
  },
  ssr: {
    resolve: {
      conditions: ['development'],
      externalConditions: ['development'],
    },
  },
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { DO_NOT_TRACK: '1' },
    setupFiles: [bunGlobalShimPath, noNetConnectPath],
    include: ['**/*.test.ts?(x)'],
    exclude: [...configDefaults.exclude, '**/*.spec.*', '**/*.e2e.*', '**/*.dom.test.ts?(x)'],
    ...(boundedMaxForks === undefined ? {} : { minWorkers: 1, maxWorkers: boundedMaxForks }),
  },
} satisfies ViteUserConfig;
