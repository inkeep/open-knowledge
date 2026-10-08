import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_DIR,
  bakedVersions,
  judgeBundle,
  RECOVERY_SECTION,
  readBundle,
} from './assert-bundle-version.mjs';

const SCRIPT = fileURLToPath(new URL('./assert-bundle-version.mjs', import.meta.url));
const CLI_ROOT = join(dirname(SCRIPT), '..');
const RECOVERY_LINE = `::error::bundle-version: nothing was packed. Fix the cause on main, then resume per RELEASES.md '${RECOVERY_SECTION}'.`;

const scratches: string[] = [];

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-bundle-version-'));
  scratches.push(dir);
  return dir;
}

function cliPackage(version: string, chunks: Record<string, string>): string {
  const dir = scratch();
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@inkeep/open-knowledge', version }),
  );
  mkdirSync(join(dir, BUNDLE_DIR), { recursive: true });
  for (const [path, source] of Object.entries(chunks)) {
    const file = join(dir, BUNDLE_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  }
  return dir;
}

const viteEnv = (version: string) =>
  `({BASE_URL:\`./\`,DEV:!1,MODE:\`production\`,PROD:!0,SSR:!1,VITE_APP_VERSION:\`${version}\`})?.VITE_OTEL_ENABLED`;

function runAlone(packageDir: string) {
  const lone = join(scratch(), 'assert-bundle-version.mjs');
  copyFileSync(SCRIPT, lone);
  return spawnSync(process.execPath, [lone, packageDir], { encoding: 'utf8' });
}

describe('bakedVersions', () => {
  it('reads the version Vite inlines for import.meta.env, in each quoting', () => {
    expect(bakedVersions(viteEnv('0.84.1-beta.7'))).toEqual(['0.84.1-beta.7']);
    expect(bakedVersions('{"VITE_APP_VERSION":"0.84.0"}')).toEqual(['0.84.0']);
    expect(bakedVersions("{VITE_APP_VERSION:'0.84.0'}")).toEqual(['0.84.0']);
  });

  it('ignores other env keys and reads of the variable', () => {
    expect(bakedVersions('({VITE_OTEL_ENABLED:`true`})?.VITE_APP_VERSION??`0.0.0`')).toEqual([]);
  });
});

describe('judgeBundle', () => {
  it('accepts a bundle whose every chunk bakes the version being published', () => {
    const dir = cliPackage('0.83.2', {
      'assets/index-a.js': viteEnv('0.83.2'),
      'assets/client-version-b.js': viteEnv('0.83.2'),
      'assets/vendor-c.js': 'export const x = 1;',
    });
    expect(judgeBundle(readBundle(dir))).toEqual([]);
  });

  it('names each stale version and the chunks that carry it', () => {
    const dir = cliPackage('0.83.2', {
      'assets/index-a.js': viteEnv('0.83.2'),
      'assets/client-version-b.js': `${viteEnv('0.82.4')};${viteEnv('0.82.4')}`,
      'assets/telemetry-impl-c.js': viteEnv('0.82.4'),
    });
    expect(judgeBundle(readBundle(dir))).toEqual([
      `${BUNDLE_DIR} was built for 0.82.4 (${join(BUNDLE_DIR, 'assets/client-version-b.js')}, ${join(BUNDLE_DIR, 'assets/telemetry-impl-c.js')}), but this is @inkeep/open-knowledge@0.83.2, so its browser bundle would send x-ok-client-runtime 0.82.4. The app was built before the version override; build it after the override`,
    ]);
  });

  it('refuses a bundle that bakes no version, pointing at the reader rather than the build order', () => {
    const dir = cliPackage('0.83.2', { 'assets/index-a.js': 'export const x = 1;' });
    expect(judgeBundle(readBundle(dir))).toEqual([
      `none of the 1 scripts in ${BUNDLE_DIR} carries a VITE_APP_VERSION literal, so the version its browser bundle reports cannot be checked against @inkeep/open-knowledge@0.83.2. If the app build changed how it inlines import.meta.env, teach bakedVersions in packages/cli/scripts/assert-bundle-version.mjs the new form`,
    ]);
  });

  it('refuses a bundle directory with no scripts as a missing app build, not a reader gap', () => {
    const dir = cliPackage('0.83.2', { 'index.html': '<!doctype html>' });
    expect(judgeBundle(readBundle(dir))).toEqual([
      `${BUNDLE_DIR} holds no scripts, so the app's build output never reached the cli; build the app before the cli copies it`,
    ]);
  });

  it('refuses a package with no version', () => {
    const dir = cliPackage('', { 'assets/index-a.js': viteEnv('0.83.2') });
    expect(judgeBundle(readBundle(dir))).toEqual([
      `@inkeep/open-knowledge has no version in its package.json, so there is nothing to compare ${BUNDLE_DIR} against`,
    ]);
  });
});

describe('the release step, run from a lone copy as the workflow runs it', () => {
  it('fails the pack when the bundle was built for another version', () => {
    const result = runAlone(
      cliPackage('0.83.2', { 'assets/client-version-b.js': viteEnv('0.82.4') }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `::error::bundle-version: ${BUNDLE_DIR} was built for 0.82.4 (${join(BUNDLE_DIR, 'assets/client-version-b.js')}), but this is @inkeep/open-knowledge@0.83.2`,
    );
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(RECOVERY_LINE);
  });

  it('passes a bundle built for the version being published', () => {
    const result = runAlone(
      cliPackage('0.83.2', { 'assets/client-version-b.js': viteEnv('0.83.2') }),
    );
    expect(result.stdout).toContain(
      `bundle-version ok: 1 of 1 scripts in ${BUNDLE_DIR} bake VITE_APP_VERSION 0.83.2, the version of @inkeep/open-knowledge`,
    );
    expect(result.status).toBe(0);
  });

  it('fails when the package has no built bundle', () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@inkeep/open-knowledge', version: '0.83.2' }),
    );
    const result = runAlone(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::bundle-version: cannot read ${dir}`);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(RECOVERY_LINE);
  });
});

describe('the built cli', () => {
  it('bakes its own version into the browser bundle it serves', () => {
    expect(judgeBundle(readBundle(CLI_ROOT))).toEqual([]);
  });
});
