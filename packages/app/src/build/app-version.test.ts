import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_RUNTIME_VERSION_FALLBACK } from '@inkeep/open-knowledge-core';
import { loadConfigFromFile } from 'vite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const stamped = vi.hoisted(() => ({ version: '9.8.7-stamped.1' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { fileURLToPath: toPath } = await import('node:url');
  const appPackageJson = toPath(new URL('../../package.json', import.meta.url));
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
    String(path) === appPackageJson
      ? JSON.stringify({ name: '@inkeep/open-knowledge-app', version: stamped.version })
      : Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

import {
  APP_VERSION_ENV_VAR,
  APP_VERSION_UNKNOWN,
  injectAppVersionEnv,
  resolveAppVersion,
} from './app-version.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('the unresolved-version sentinel', () => {
  test('matches the core client-version fallback it is duplicated from', () => {
    expect(APP_VERSION_UNKNOWN).toBe(CLIENT_RUNTIME_VERSION_FALLBACK);
  });
});

describe('resolveAppVersion', () => {
  let fixtureDir = '';
  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'ok-app-version-'));
  });
  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  test('reads packages/app/package.json by default', () => {
    expect(resolveAppVersion()).toBe(stamped.version);
  });

  test('returns the version a package.json carries, not the sentinel', () => {
    const pkgPath = join(fixtureDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: 'fixture', version: '1.2.3-beta.4' }));
    expect(resolveAppVersion(pkgPath)).toBe('1.2.3-beta.4');
  });

  test('falls back to the sentinel when the package.json is missing, unparseable or versionless', () => {
    expect(resolveAppVersion(join(fixtureDir, 'absent.json'))).toBe(APP_VERSION_UNKNOWN);
    const broken = join(fixtureDir, 'broken.json');
    writeFileSync(broken, '{');
    expect(resolveAppVersion(broken)).toBe(APP_VERSION_UNKNOWN);
    const versionless = join(fixtureDir, 'versionless.json');
    writeFileSync(versionless, JSON.stringify({ name: 'fixture', version: '' }));
    expect(resolveAppVersion(versionless)).toBe(APP_VERSION_UNKNOWN);
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
    expect(returned).toBe(stamped.version);
    expect(process.env[APP_VERSION_ENV_VAR]).toBe(stamped.version);
  });
});

describe('build-path version injection', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('vite.config.ts injects the app package version while loading', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const committed = (
      JSON.parse(actualFs.readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8')) as {
        version: string;
      }
    ).version;
    const configPath = resolve(here, '../..', 'vite.config.ts');
    vi.stubEnv(APP_VERSION_ENV_VAR, undefined);
    vi.stubEnv('LINGUI_CONFIG', undefined);
    const result = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      configPath,
      dirname(configPath),
    );
    expect(result).not.toBeNull();
    expect(process.env[APP_VERSION_ENV_VAR]).toBe(committed);
  });
});
