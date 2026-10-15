import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createRestartableServer } from '../../packages/app/tests/integration/restartable-server.test-helper.ts';
import { createTestServer } from '../../packages/app/tests/integration/test-harness.ts';
import { bootCompositionRig } from '../../packages/server/src/composition-rig.test-helper.ts';
import { testAuthorityRegistryPath } from '../server-authority-registry.test-helper.ts';
import { withTempDir } from '../temp-dir.test-helper.ts';

test('composition rig uses the shared authority registry', async () => {
  await withTempDir('ok-registry-composition-', async (content) => {
    const server = await bootCompositionRig(content);
    try {
      await server.ready;
      expect(existsSync(testAuthorityRegistryPath)).toBe(true);
    } finally {
      await server.destroy();
    }
  });
});

test('integration server uses the shared authority registry', async () => {
  const server = await createTestServer();
  try {
    expect(existsSync(testAuthorityRegistryPath)).toBe(true);
  } finally {
    await server.cleanup();
  }
});

test('restartable server uses the shared authority registry', async () => {
  const server = await createRestartableServer();
  try {
    expect(existsSync(testAuthorityRegistryPath)).toBe(true);
  } finally {
    await server.shutdown();
  }
});
