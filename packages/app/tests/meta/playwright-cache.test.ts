import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { withTempDir } from '../../../../test-support/temp-dir.test-helper.ts';

test('native browser children retain the provisioned cache when HOME is isolated', async () => {
  const browser = await import('@playwright/test');
  const executable = browser.chromium.executablePath();
  await withTempDir('ok-browser-child-home-', async (home) => {
    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("@playwright/test").chromium.executablePath())'],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8',
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(executable);
  });
});
