import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { appNodeVitestConfig } from '../../../vitest.node.config';

export default defineConfig({
  ...appNodeVitestConfig,
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  test: {
    ...appNodeVitestConfig.test,
    include: ['tests/foundation/fixtures/*.node-fixture.ts'],
  },
});
