import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

describe('build-path wiring (R-3)', () => {
  const repoConfigs = [
    resolve(here, '..', '..', 'vite.config.ts'),
    resolve(here, '..', '..', '..', 'desktop', 'electron.vite.config.ts'),
  ];
  for (const configPath of repoConfigs) {
    test(`${configPath.split('/packages/')[1]} calls injectAppVersionEnv()`, () => {
      const src = readFileSync(configPath, 'utf-8');
      expect(src).toContain('injectAppVersionEnv()');
    });
  }
});
