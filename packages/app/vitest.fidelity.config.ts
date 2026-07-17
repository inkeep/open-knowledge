import { defineConfig, type ViteUserConfig } from 'vitest/config';
import { appVitestConfig } from './vitest.config';

// Fidelity PBTs (property-based invariants I1-I21 + handler PBTs + corpus) run
// many fast-check iterations per test and are minutes-slow as a tier; keep the
// 120s per-test budget the bun script carried (`bun test --timeout 120000`).
// Everything else is shared with the app base config (lingui shim, dedupe,
// development-conditions pin, Bun global facade).
export default defineConfig({
  ...appVitestConfig,
  test: {
    ...appVitestConfig.test,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
} satisfies ViteUserConfig);
