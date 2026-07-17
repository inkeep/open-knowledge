import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

/**
 * Vitest config for packages/cli (unit + integration tier).
 *
 * Spreads the shared workspace base (`development` export-condition pin,
 * `bun:test` alias shim, `Bun` global facade, `import.meta.dir` transform, 30s
 * timeout). The base `include` matches every `*.test.ts` under the package,
 * which reproduces the file set `bun test` auto-discovered before the flip. The
 * black-box `tests/e2e/cli-linux-e2e.ts` deliberately omits the `.test` infix so
 * it stays out of this tier; it runs under `vitest.e2e.config.ts`.
 */
export default defineConfig({ ...okVitestBase });
