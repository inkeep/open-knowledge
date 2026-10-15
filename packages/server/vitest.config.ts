import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { okVitestBase } from '../../test-support/vitest.base';

const serverAuthorityRegistrySetup = fileURLToPath(
  new URL('../../test-support/server-authority-registry.setup.ts', import.meta.url),
);

export default defineConfig({
  ...okVitestBase,
  test: {
    ...okVitestBase.test,
    setupFiles: [...okVitestBase.test.setupFiles, serverAuthorityRegistrySetup],
    exclude: [...okVitestBase.test.exclude, '**/*.network.test.ts', '.ok-skill-publish-*'],
  },
});
