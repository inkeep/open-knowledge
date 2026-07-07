import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION_ENV_VAR, injectAppVersionEnv, resolveAppVersion } from './app-version.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appPkgVersion = (
  JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8')) as {
    version: string;
  }
).version;

describe('resolveAppVersion', () => {
  test('returns the real packages/app/package.json version, not a sentinel', () => {
    const version = resolveAppVersion();
    expect(version).toBe(appPkgVersion);
    // A build must never silently inject a placeholder.
    expect(version).not.toBe('dev');
    expect(version).not.toBe('0.0.0-unknown');
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

// guard: the injection must be wired into EVERY build path or the browser
// silently falls back to the sentinel. The two configs cannot be imported in
// the unit tier (vite.config pulls in the full server via hocuspocusPlugin;
// electron.vite runs a top-level `await babel()` and needs the electron-vite
// runner) — runtime coverage here is infeasible, so we assert the wiring at the
// source level instead.
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
