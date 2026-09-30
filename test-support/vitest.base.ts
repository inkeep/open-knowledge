import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDefaults, type Plugin, type ViteUserConfig } from 'vitest/config';
import { UNCACHED_TEST_GLOBS } from './uncached-tier';

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
    expect: { requireAssertions: true },
    tags: [
      {
        name: 'known-bug',
        description:
          'Asserts the correct behaviour of a tracked bug through expectKnownBug; listed by pnpm known-reds.',
      },
      {
        name: 'quarantine',
        description:
          'A flaky test declared skipped with an issue, an owner and an expiry; listed by pnpm known-reds.',
      },
    ],
    setupFiles: [bunGlobalShimPath, noNetConnectPath],
    include: ['**/*.test.ts?(x)'],
    exclude: [
      ...configDefaults.exclude,
      '**/*.spec.*',
      '**/*.e2e.*',
      '**/*.dom.test.ts?(x)',
      ...UNCACHED_TEST_GLOBS,
    ],
    ...(boundedMaxForks === undefined ? {} : { minWorkers: 1, maxWorkers: boundedMaxForks }),
  },
} satisfies ViteUserConfig;
