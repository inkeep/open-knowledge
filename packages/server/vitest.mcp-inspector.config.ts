import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    setupFiles: [
      ...okVitestBase.test.setupFiles,
      fileURLToPath(new URL('./tests/support/zod-compile.test-helper.ts', import.meta.url)),
    ],
    include: ['src/mcp/mcp-inspector-portability.network.test.ts'],
  },
});
