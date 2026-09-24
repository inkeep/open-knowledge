import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = resolve(desktopRoot, '../..');
const require_ = createRequire(import.meta.url);
const builderRequire = createRequire(require_.resolve('electron-builder'));
const collectorPath = builderRequire.resolve('app-builder-lib/out/node-module-collector/index.js');

describe('desktop packaging package manager', () => {
  test('keeps the desktop package manager aligned with the workspace', () => {
    const desktop = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
    const workspace = JSON.parse(readFileSync(resolve(workspaceRoot, 'package.json'), 'utf8'));
    expect(desktop.packageManager).toBe(workspace.packageManager);
  });

  test.each([undefined, 'npm/11.0.0 node/v24.18.0'])(
    'selects pnpm and its workspace for a direct Node invocation with user agent %s',
    (userAgent) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^npm_/i.test(key) || key === 'INIT_CWD') delete env[key];
      }
      if (userAgent) env.npm_config_user_agent = userAgent;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import { createRequire } from 'node:module';
            const require = createRequire(import.meta.url);
            const { determinePackageManagerEnv } = require(${JSON.stringify(collectorPath)});
            const result = await determinePackageManagerEnv({
              projectDir: process.cwd(), appDir: process.cwd(), workspaceRoot: undefined,
            }).value;
            console.log(JSON.stringify({ pm: result.pm, root: await result.workspaceRoot }));
          `,
        ],
        { cwd: desktopRoot, env, encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1))).toEqual({
        pm: 'pnpm',
        root: workspaceRoot,
      });
    },
  );
});
