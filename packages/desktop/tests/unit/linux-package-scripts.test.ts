import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createVariantPostRemove,
  createVariantPostTransaction,
} from '../../scripts/desktop-variant-config.ts';
import { DESKTOP_VARIANTS } from '../../src/shared/desktop-variant.ts';
import { removeTempDirBestEffort } from '../support/temp-dir-cleanup.test-helper';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = 'profile openknowledge-beta flags=(unconfined) { userns, }\n';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTempDirBestEffort(root);
});

function installRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ok-linux-scripts-'));
  roots.push(root);
  const app = join(root, 'opt/OpenKnowledge Beta');
  mkdirSync(join(app, 'resources/cli/bin'), { recursive: true });
  for (const dir of ['etc/apparmor.d', 'usr/bin', 'usr/share/mime', 'usr/share/applications']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(app, 'openknowledge-beta'), '');
  writeFileSync(join(app, 'chrome-sandbox'), '');
  writeFileSync(join(app, 'resources/apparmor-profile'), PROFILE);
  writeFileSync(join(app, 'resources/cli/bin/ok.sh'), '');
  const stubs = join(root, 'stubs');
  mkdirSync(stubs);
  for (const [name, status] of [
    ['apparmor_status', 0],
    ['apparmor_parser', 0],
    ['update-alternatives', 1],
    ['update-mime-database', 0],
    ['update-desktop-database', 0],
  ] as const) {
    writeFileSync(join(stubs, name), `#!/bin/sh\nexit ${status}\n`);
    chmodSync(join(stubs, name), 0o755);
  }
  return root;
}

function run(root: string, script: string, action: string) {
  const rooted = script.replace(/(?<=['" =])\/(opt|usr|etc)\//g, `${root}/$1/`);
  const result = spawnSync('bash', ['-s', action], {
    input: rooted,
    encoding: 'utf8',
    env: { PATH: `${join(root, 'stubs')}:/usr/bin:/bin` },
  });
  expect(result.status, result.stderr).toBe(0);
}

function expandMacros(script: string) {
  const variant = DESKTOP_VARIANTS.beta;
  const macros = new Map([
    ['executable', variant.linuxExecutableName],
    ['sanitizedProductName', variant.productName],
  ]);
  return script.replace(/\$\{([^}]*)\}/g, (macro, name: string) => macros.get(name) ?? macro);
}

const postInstall = () =>
  createVariantPostTransaction(
    readFileSync(resolve(desktopRoot, 'build/deb-postinst.sh'), 'utf8'),
    'beta',
  );
const postRemove = () =>
  expandMacros(
    createVariantPostRemove(
      readFileSync(resolve(desktopRoot, 'build/deb-postrm.sh'), 'utf8'),
      'beta',
    ),
  );
const retiredPostRemove = () =>
  readFileSync(resolve(desktopRoot, 'tests/support/retired-beta-deb-postrm.sh'), 'utf8');

function installedProfiles(root: string) {
  const dir = join(root, 'etc/apparmor.d');
  return readdirSync(dir).filter((name) => readFileSync(join(dir, name), 'utf8') === PROFILE);
}

describe.skipIf(process.platform === 'win32')('Beta deb maintainer scripts', () => {
  test('keeps the AppArmor profile when the retired package’s leftover record is purged', () => {
    const root = installRoot();
    run(root, postInstall(), 'configure');
    expect(installedProfiles(root)).toHaveLength(1);

    run(root, retiredPostRemove(), 'purge');

    expect(installedProfiles(root)).toHaveLength(1);
  });

  test('a reinstall restores the CLI links that purge deletes', () => {
    const root = installRoot();
    run(root, postInstall(), 'configure');
    run(root, retiredPostRemove(), 'purge');
    expect(existsSync(join(root, 'usr/bin/ok-beta'))).toBe(false);

    run(root, postInstall(), 'configure');

    for (const link of ['ok-beta', 'open-knowledge-beta']) {
      expect(existsSync(join(root, 'usr/bin', link))).toBe(true);
    }
    expect(installedProfiles(root)).toHaveLength(1);
  });

  test('moves a profile an earlier package installed so only one copy loads', () => {
    const root = installRoot();
    writeFileSync(join(root, 'etc/apparmor.d/openknowledge-beta'), PROFILE);

    run(root, postInstall(), 'configure');

    expect(installedProfiles(root)).toHaveLength(1);
  });

  test('removing the package removes its profile and links', () => {
    const root = installRoot();
    run(root, postInstall(), 'configure');

    run(root, postRemove(), 'remove');

    expect(installedProfiles(root)).toEqual([]);
    for (const link of ['ok-beta', 'open-knowledge-beta']) {
      expect(existsSync(join(root, 'usr/bin', link))).toBe(false);
    }
  });
});
