import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { APP_VERSION_ENV_VAR } from '../../../app/src/build/app-version';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const appPkgVersion = (
  JSON.parse(readFileSync(resolve(desktopRoot, '../app/package.json'), 'utf-8')) as {
    version: string;
  }
).version;

describe('desktop build version injection', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('electron.vite.config.ts injects the app package version while loading', async () => {
    const configPath = resolve(desktopRoot, 'electron.vite.config.ts');
    vi.stubEnv(APP_VERSION_ENV_VAR, undefined);
    vi.stubEnv('LINGUI_CONFIG', undefined);
    const result = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      configPath,
      desktopRoot,
    );
    expect(result).not.toBeNull();
    expect(process.env[APP_VERSION_ENV_VAR]).toBe(appPkgVersion);
  });
});
