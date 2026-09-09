import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { gitCleanEnv } from '../scripts/git-clean-env.mjs';
import { okVitestBase } from './vitest.base';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CONFIG_FILENAME = /(?:^|\.)vite(st)?[\w.-]*\.config\.m?[jt]s$/;
const TEST_CONFIG_FILENAME = /(?:^|\.)vitest[\w.-]*\.config\.m?[jt]s$/;

const KNOWN_TEST_PROJECTS = [
  'docs/vitest.config.ts',
  'docs/vitest.real-source.config.mts',
  'packages/app/vitest.config.ts',
  'packages/app/vitest.dom.config.ts',
  'packages/app/vitest.fidelity.config.ts',
  'packages/app/vitest.integration.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/cli/vitest.e2e.config.ts',
  'packages/core/vitest.config.ts',
  'packages/desktop/vitest.config.ts',
  'packages/md-conformance/md-audit/vitest.config.ts',
  'packages/md-conformance/vitest.config.ts',
  'packages/server/vitest.config.ts',
  'vitest.config.ts',
  'vitest.scripts.config.ts',
];

const KNOWN_BUILD_CONFIGS = [
  'packages/app/vite.config.ts',
  'packages/desktop/electron.vite.config.ts',
];

const REQUIRED_BASE_SETUP_FILES = ['bun-global-shim.ts', 'no-net-connect.ts'];

const isTestConfig = (relPath: string): boolean => TEST_CONFIG_FILENAME.test(basename(relPath));

function findConfigs(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--', '*.config.ts', '*.config.mts', '*.config.js', '*.config.mjs'],
    {
      cwd: REPO_ROOT,
      env: gitCleanEnv(),
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((relPath) => relPath !== '' && CONFIG_FILENAME.test(basename(relPath)))
    .sort();
}

async function resolveSetupFiles(relPath: string): Promise<string[]> {
  const loaded: unknown = await import(pathToFileURL(join(REPO_ROOT, relPath)).href);
  const exported = (loaded as { default?: unknown }).default ?? loaded;
  const config =
    typeof exported === 'function' ? await exported({ command: 'serve', mode: 'test' }) : exported;
  const setupFiles = (config as { test?: { setupFiles?: unknown } }).test?.setupFiles;
  if (setupFiles === undefined) return [];
  return (Array.isArray(setupFiles) ? setupFiles : [setupFiles]).map(String);
}

const configs = findConfigs();

describe('vitest setupFiles contract', () => {
  test('every tracked config is present in the working tree', () => {
    const missing = configs.filter((relPath) => !existsSync(join(REPO_ROOT, relPath)));
    expect(
      missing,
      `git lists these configs but they are absent from the working tree: ${missing.join(', ')}. ` +
        'The sweep reads the index, so a vitest one fails below as module-not-found, and a ' +
        'build config passes every other assertion here, because the index still lists it.',
    ).toEqual([]);
  });

  test('the shared base itself still installs every required setup file', () => {
    for (const required of REQUIRED_BASE_SETUP_FILES) {
      expect(
        okVitestBase.test.setupFiles.some((entry) => basename(entry) === required),
        `okVitestBase.test.setupFiles no longer installs ${required}, so every project ` +
          'below would agree with a base that stopped installing it.',
      ).toBe(true);
    }
  });

  test('the sweep sees exactly the vitest projects the repo tracks', () => {
    expect(
      configs.filter(isTestConfig).sort(),
      'A vitest project appeared or disappeared. Confirm the new one is covered, then update ' +
        'this list; a lower bound would have let a disappearing project pass silently.',
    ).toEqual([...KNOWN_TEST_PROJECTS].sort());
  });

  test('every non-vitest config in the sweep is a known build config', () => {
    expect(configs.filter((relPath) => !isTestConfig(relPath)).sort()).toEqual(
      [...KNOWN_BUILD_CONFIGS].sort(),
    );
  });

  test.each(
    configs.filter(isTestConfig),
  )('%s resolves setupFiles containing every entry the shared base installs', async (relPath) => {
    const setupFiles = await resolveSetupFiles(relPath);
    const missing = okVitestBase.test.setupFiles.filter((entry) => !setupFiles.includes(entry));
    expect(
      missing,
      `${relPath} omits ${missing.length} shared setup file(s); it resolves ` +
        `[${setupFiles.join(', ')}]. Build it from okVitestBase.test.setupFiles ` +
        'rather than listing entries by hand.',
    ).toEqual([]);
  });
});
