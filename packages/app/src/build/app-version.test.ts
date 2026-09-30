import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { loadConfigFromFile } from 'vite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  APP_VERSION_ENV_VAR,
  APP_VERSION_UNKNOWN,
  injectAppVersionEnv,
  resolveAppVersion,
} from './app-version.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appPkgVersion = (
  JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  }
).version;

describe('the unresolved-version sentinel', () => {
  test('matches the core client-version fallback it is duplicated from', () => {
    expect(APP_VERSION_UNKNOWN).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
  });
});

describe('resolveAppVersion', () => {
  test('returns the real packages/app/package.json version, not a sentinel', () => {
    const version = resolveAppVersion();
    expect(version).toBe(appPkgVersion);
    expect(version).not.toBe('dev');
    expect(version).not.toBe(APP_VERSION_UNKNOWN);
  });
});

describe('injectAppVersionEnv', () => {
  const original = process.env[APP_VERSION_ENV_VAR];
  beforeEach(() => {
    delete process.env[APP_VERSION_ENV_VAR];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[APP_VERSION_ENV_VAR];
    else process.env[APP_VERSION_ENV_VAR] = original;
  });

  test('sets VITE_APP_VERSION on process.env and returns it', () => {
    const returned = injectAppVersionEnv();
    expect(returned).toBe(appPkgVersion);
    expect(process.env[APP_VERSION_ENV_VAR]).toBe(appPkgVersion);
  });
});

describe('build-path version injection', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('vite.config.ts injects the app package version while loading', async () => {
    const configPath = resolve(here, '../..', 'vite.config.ts');
    vi.stubEnv(APP_VERSION_ENV_VAR, undefined);
    vi.stubEnv('LINGUI_CONFIG', undefined);
    const result = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      configPath,
      dirname(configPath),
    );
    expect(result).not.toBeNull();
    expect(process.env[APP_VERSION_ENV_VAR]).toBe(appPkgVersion);
  });
});
