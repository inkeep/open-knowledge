import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

/**
 * Vitest config for the black-box CLI e2e (`test:e2e:cli`, the `cli-e2e` CI job).
 *
 * The single spec `tests/e2e/cli-linux-e2e.ts` deliberately omits the `.test`
 * infix so the unit tier never auto-discovers it. That also means the base
 * `include` glob does not match it and a bare CLI positional collects nothing,
 * so `include` is pinned to the one file here while keeping the shared base
 * (`bun:test` shim, `Bun` facade, development-condition pin, 30s timeout).
 */
export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    include: ['tests/e2e/cli-linux-e2e.ts'],
  },
});
