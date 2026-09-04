import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { MAX_ASAR_HEADER_BYTES, readAsarHeader } from '../../scripts/lib/asar-header.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '../..');
const packageDirInput = process.env.OK_WIN_PACKAGE_DIR?.trim() ?? '';
const packageDir = packageDirInput === '' ? null : resolve(desktopRoot, packageDirInput);
const packageDirRequired = process.env.OK_WIN_PACKAGE_REQUIRED === '1';

const WIN32_ARCHES = ['win32-x64', 'win32-arm64'] as const;

const PE_MACHINE: Record<(typeof WIN32_ARCHES)[number], number> = {
  'win32-x64': 0x8664,
  'win32-arm64': 0xaa64,
};

const CONPTY_FILES = [
  'conpty.node',
  'conpty_console_list.node',
  'conpty/conpty.dll',
  'conpty/OpenConsole.exe',
] as const;

function peMachineType(binary: Buffer): number {
  if (binary.length < 0x40 || binary.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('not a PE image: missing MZ magic');
  }
  const peOffset = binary.readUInt32LE(0x3c);
  if (peOffset + 6 > binary.length || binary.readUInt32LE(peOffset) !== 0x4550) {
    throw new Error('not a PE image: missing PE signature');
  }
  return binary.readUInt16LE(peOffset + 4);
}

function syntheticPe(machine: number): Buffer {
  const buffer = Buffer.alloc(0x90);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  visit(root, '');
  return found.sort();
}

type AsarDirNode = { files?: Record<string, unknown> };

function asarEntryPaths(header: AsarDirNode): string[] {
  const paths: string[] = [];
  const visit = (node: AsarDirNode, prefix: string): void => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      paths.push(path);
      if (typeof entry === 'object' && entry !== null && 'files' in entry) {
        visit(entry as AsarDirNode, path);
      }
    }
  };
  visit(header, '');
  return paths.sort();
}

function writeSyntheticAsar(path: string, header: object): void {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  writeFileSync(path, Buffer.concat([prefix, json]));
}

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Windows package native guard helpers', () => {
  test('extracts the PE machine word for both shipped architectures', () => {
    expect(peMachineType(syntheticPe(0x8664))).toBe(0x8664);
    expect(peMachineType(syntheticPe(0xaa64))).toBe(0xaa64);
  });

  test('rejects non-PE bytes instead of returning a garbage machine word', () => {
    expect(() => peMachineType(Buffer.from('ELF-not-PE'))).toThrow(/MZ magic/);
    const mzOnly = Buffer.alloc(0x90);
    mzOnly.writeUInt16LE(0x5a4d, 0);
    mzOnly.writeUInt32LE(0x80, 0x3c);
    expect(() => peMachineType(mzOnly)).toThrow(/PE signature/);
  });

  test('walks nested package trees and reports files only, as relative paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-win-native-guard-'));
    fixtureDirs.push(root);
    const nested = join(root, 'prebuilds', 'win32-x64', 'conpty');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'conpty.dll'), 'pe');
    writeFileSync(join(root, 'package.json'), '{}');
    expect(walkFiles(root)).toEqual(['package.json', 'prebuilds/win32-x64/conpty/conpty.dll']);
  });

  test('lists every entry of an asar header, including directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-win-native-guard-asar-'));
    fixtureDirs.push(root);
    const asar = join(root, 'app.asar');
    writeSyntheticAsar(asar, {
      files: {
        node_modules: {
          files: {
            'node-pty': {
              files: {
                third_party: { files: { 'winpty.cc': { size: 1, offset: '0' } } },
                'package.json': { size: 2, offset: '1' },
              },
            },
          },
        },
      },
    });
    expect(asarEntryPaths(readAsarHeader(asar) as AsarDirNode)).toEqual([
      'node_modules',
      'node_modules/node-pty',
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/third_party',
      'node_modules/node-pty/third_party/winpty.cc',
    ]);
  });

  test('rejects an asar header length above the shared allocation bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'ok-win-native-guard-asar-bound-'));
    fixtureDirs.push(root);
    const asar = join(root, 'app.asar');
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(MAX_ASAR_HEADER_BYTES + 1, 12);
    writeFileSync(asar, prefix);

    expect(() => readAsarHeader(asar)).toThrow(/implausible asar header length/);
  });
});

describe('Windows package native guard lane visibility', () => {
  test('reports whether OK_WIN_PACKAGE_DIR enabled the assertive lane', () => {
    if (packageDir === null) {
      expect(packageDirRequired, 'OK_WIN_PACKAGE_DIR is required for this package lane').toBe(
        false,
      );
      console.log(
        '[windows-package-native-guards] OK_WIN_PACKAGE_DIR is unset — packaged-artifact assertions skipped',
      );
      return;
    }
    console.log(`[windows-package-native-guards] checking ${packageDir}`);
    expect(packageDirInput).not.toBe('');
  });
});

describe.skipIf(packageDir === null)('packaged Windows node-pty payload', () => {
  const nodePtyUnpackedRoot = join(
    packageDir ?? '',
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
  const appAsarPath = join(packageDir ?? '', 'resources', 'app.asar');

  test('control: package dir carries an unpacked node-pty tree and an app.asar (a wrong dir cannot pass vacuously)', () => {
    expect(existsSync(nodePtyUnpackedRoot), `no unpacked node-pty at ${nodePtyUnpackedRoot}`).toBe(
      true,
    );
    expect(existsSync(appAsarPath), `no app.asar at ${appAsarPath}`).toBe(true);
    expect(
      walkFiles(nodePtyUnpackedRoot).length,
      'unpacked node-pty tree is empty',
    ).toBeGreaterThan(0);
  });

  test.each(
    WIN32_ARCHES,
  )('%s prebuild ships arch-correct PE addons with the ConPTY pair beside them', (arch) => {
    const archDir = join(nodePtyUnpackedRoot, 'prebuilds', arch);
    for (const name of CONPTY_FILES) {
      const file = join(archDir, name);
      expect(existsSync(file), `missing ${arch}/${name}`).toBe(true);
      expect(peMachineType(readFileSync(file)), `${arch}/${name}: PE machine word`).toBe(
        PE_MACHINE[arch],
      );
    }
  });

  test('unpacked tree carries no debug symbols, foreign prebuilds, or native-build output', () => {
    const offenders = walkFiles(nodePtyUnpackedRoot).filter(
      (file) =>
        file.endsWith('.pdb') ||
        /^(build|third_party)\//.test(file) ||
        (file.startsWith('prebuilds/') && !file.startsWith('prebuilds/win32-')),
    );
    expect(offenders, `pruned paths shipped: ${offenders.slice(0, 10).join(', ')}`).toEqual([]);
  });

  test('app.asar carries node-pty but none of the pruned trees', () => {
    const entries = asarEntryPaths(readAsarHeader(appAsarPath));
    const nodePtyEntries = entries.filter((entry) => entry.startsWith('node_modules/node-pty/'));
    expect(nodePtyEntries.length, 'node-pty absent from app.asar').toBeGreaterThan(0);
    const offenders = nodePtyEntries.filter(
      (entry) =>
        entry.endsWith('.pdb') ||
        /^node_modules\/node-pty\/(build|third_party)(\/|$)/.test(entry) ||
        /^node_modules\/node-pty\/prebuilds\/(?!win32-)/.test(entry),
    );
    expect(offenders, `pruned paths inside app.asar: ${offenders.slice(0, 10).join(', ')}`).toEqual(
      [],
    );
  });

  test('conout worker and its CJS resolution anchors are on the real filesystem', () => {
    for (const rel of [
      'lib/worker/conoutSocketWorker.js',
      'lib/shared/conout.js',
      'package.json',
    ]) {
      expect(
        existsSync(join(nodePtyUnpackedRoot, rel)),
        `missing unpacked node-pty/${rel} — the ConPTY conout worker runs on a worker thread, which cannot load from inside an asar`,
      ).toBe(true);
    }
  });

  test('unpacked node-pty payload stays inside the size budget', () => {
    const bytes = walkFiles(nodePtyUnpackedRoot).reduce(
      (sum, rel) => sum + statSync(join(nodePtyUnpackedRoot, rel)).size,
      0,
    );
    expect(
      bytes,
      'unpacked node-pty exceeds the ~3.5 MB payload budget — a .pdb or foreign-prebuild regression adds tens of MB',
    ).toBeLessThanOrEqual(3.5 * 1024 * 1024);
  });
});
