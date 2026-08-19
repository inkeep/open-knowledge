import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const packageDirInput = process.env.OK_LINUX_PACKAGE_DIR?.trim() ?? '';
const packageDir = packageDirInput === '' ? null : resolve(desktopRoot, packageDirInput);

const MAX_NATIVE_VERSIONS = {
  GLIBC: '2.31',
  GLIBCXX: '3.4.28',
} as const;

type NativeVersionFamily = keyof typeof MAX_NATIVE_VERSIONS;

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  const width = Math.max(a.length, b.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requiredNativeVersions(binary: Buffer): Map<NativeVersionFamily, string> {
  const required = new Map<NativeVersionFamily, string>();
  const text = binary.toString('latin1');
  for (const match of text.matchAll(/\b(GLIBCXX|GLIBC)_(\d+\.\d+(?:\.\d+)?)\b/g)) {
    const family = match[1] as NativeVersionFamily;
    const version = match[2];
    const current = required.get(family);
    if (current === undefined || compareVersions(version, current) > 0) {
      required.set(family, version);
    }
  }
  return required;
}

function findNativeAddons(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.node')) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Linux package native-version guard helpers', () => {
  test('extracts the highest GLIBC and GLIBCXX version tags numerically', () => {
    const versions = requiredNativeVersions(
      Buffer.from('GLIBC_2.9\0GLIBC_2.31\0GLIBC_2.28\0GLIBCXX_3.4.9\0GLIBCXX_3.4.28'),
    );
    expect(Object.fromEntries(versions)).toEqual({ GLIBC: '2.31', GLIBCXX: '3.4.28' });
  });

  test('walks nested package resources without treating non-.node files as addons', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-linux-native-guard-'));
    fixtureDirs.push(root);
    const nested = join(root, 'resources', 'app.asar.unpacked');
    const addon = join(nested, 'pty.node');
    const sibling = join(nested, 'helper.txt');
    mkdirSync(nested, { recursive: true });
    writeFileSync(addon, 'ELF');
    writeFileSync(sibling, 'not native');
    expect(findNativeAddons(root)).toEqual([addon]);
  });
});

describe('Linux package native guard lane visibility', () => {
  test('reports whether OK_LINUX_PACKAGE_DIR enabled the assertive lane', () => {
    if (packageDir === null) {
      console.log(
        '[linux-package-native-guards] OK_LINUX_PACKAGE_DIR is unset — packaged-artifact assertions skipped',
      );
      return;
    }
    console.log(`[linux-package-native-guards] checking ${packageDir}`);
    expect(packageDirInput).not.toBe('');
  });
});

describe.skipIf(packageDir === null)('packaged Linux native modules', () => {
  test('carries node-pty for the packaged architecture', () => {
    expect(
      process.platform,
      'OK_LINUX_PACKAGE_DIR must only be set in a Linux packaging lane',
    ).toBe('linux');
    const ptyNode = join(
      packageDir as string,
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'prebuilds',
      `linux-${process.arch}`,
      'pty.node',
    );
    expect(
      statSync(ptyNode).isFile(),
      `packaged node-pty prebuild missing at ${relative(packageDir as string, ptyNode)}`,
    ).toBe(true);
  });

  test('keeps every shipped native addon within Electron’s Debian 11 ABI floor', () => {
    const addons = findNativeAddons(packageDir as string);
    expect(addons.length, `no .node binaries found under ${packageDir}`).toBeGreaterThan(0);

    for (const addon of addons) {
      const versions = requiredNativeVersions(readFileSync(addon));
      for (const [family, maximum] of Object.entries(MAX_NATIVE_VERSIONS) as Array<
        [NativeVersionFamily, string]
      >) {
        const required = versions.get(family);
        if (required === undefined) continue;
        expect(
          compareVersions(required, maximum),
          `${relative(packageDir as string, addon)} requires ${family}_${required}, above the recorded ${family}_${maximum} Electron floor`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });
});
