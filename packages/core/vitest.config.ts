import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

/**
 * Vitest config for packages/core.
 *
 * Spreads the shared workspace base (`development` export-condition pin,
 * `bun:test` alias shim, `Bun` global facade, `import.meta.dir` transform, 30s
 * timeout). The base `include` matches every `*.test.ts` under the package; each
 * `test*` npm script narrows to its tier with path positionals, mirroring what
 * `bun test <dir…>` selected before the flip.
 */
export default defineConfig({ ...okVitestBase });
