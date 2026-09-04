import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ensureNodePtySpawnHelperExecutable,
  ensureNodePtySpawnHelperExecutableInNodeModules,
  ensureNodePtySpawnHelperExecutableInNodeModulesSafe,
  shouldEnsureNodePtySpawnHelper,
} from '../../scripts/ensure-node-pty-exec.mjs';

const tmpRoots: string[] = [];

function helperPath(resourcesDir: string, arch: string): string {
  return join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
    arch,
    'spawn-helper',
  );
}

function makeResourcesFixture(archDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-nodepty-exec-'));
  tmpRoots.push(root);
  for (const arch of archDirs) {
    const helper = helperPath(root, arch);
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, 'fake-mach-o');
    chmodSync(helper, 0o644);
  }
  return root;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureNodePtySpawnHelperExecutable', () => {
  test('promotes the shipped darwin-arm64 spawn-helper from 0644 to executable 0755', () => {
    const resourcesDir = makeResourcesFixture(['darwin-arm64']);
    const helper = helperPath(resourcesDir, 'darwin-arm64');
    expect(statSync(helper).mode & 0o111).toBe(0);

    const chmodded = ensureNodePtySpawnHelperExecutable(resourcesDir);

    expect(chmodded).toContain(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  test('chmods every prebuild arch the unpack rule extracted, not just the shipped one', () => {
    const resourcesDir = makeResourcesFixture(['darwin-arm64', 'darwin-x64']);

    const chmodded = ensureNodePtySpawnHelperExecutable(resourcesDir);

    expect(chmodded.length).toBe(2);
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      expect(statSync(helperPath(resourcesDir, arch)).mode & 0o777).toBe(0o755);
    }
  });

  test('throws when the shipped darwin-arm64 spawn-helper is absent (broken packaging is a hard build error)', () => {
    const resourcesDir = makeResourcesFixture(['darwin-x64']);
    expect(() => ensureNodePtySpawnHelperExecutable(resourcesDir)).toThrow(
      /darwin-arm64 spawn-helper missing/,
    );
  });
});

function nodeModulesHelperPath(nodePtyDir: string, arch: string): string {
  return join(nodePtyDir, 'prebuilds', arch, 'spawn-helper');
}

function makeNodeModulesFixture(archDirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-nodepty-dev-exec-'));
  tmpRoots.push(root);
  const nodePtyDir = join(root, 'node_modules', 'node-pty');
  for (const arch of archDirs) {
    const helper = nodeModulesHelperPath(nodePtyDir, arch);
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(helper, 'fake-mach-o');
    chmodSync(helper, 0o644);
  }
  return nodePtyDir;
}

describe('ensureNodePtySpawnHelperExecutableInNodeModules', () => {
  test('promotes the shipped darwin-arm64 spawn-helper from 0644 to executable 0755', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-arm64']);
    const helper = nodeModulesHelperPath(nodePtyDir, 'darwin-arm64');
    expect(statSync(helper).mode & 0o111).toBe(0);

    const chmodded = ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir);

    expect(chmodded).toContain(helper);
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  test('chmods every prebuild arch present in node_modules, not just the shipped one', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-arm64', 'darwin-x64']);

    const chmodded = ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir);

    expect(chmodded.length).toBe(2);
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      expect(statSync(nodeModulesHelperPath(nodePtyDir, arch)).mode & 0o777).toBe(0o755);
    }
  });

  test('throws when the shipped darwin-arm64 spawn-helper is absent (broken install is a hard error)', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-x64']);
    expect(() => ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir)).toThrow(
      /darwin-arm64 spawn-helper missing/,
    );
  });
});

describe('ensureNodePtySpawnHelperExecutableInNodeModulesSafe', () => {
  test('returns ok + chmodded on a healthy install and actually flips the bit', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-arm64']);
    const result = ensureNodePtySpawnHelperExecutableInNodeModulesSafe(nodePtyDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chmodded).toContain(nodeModulesHelperPath(nodePtyDir, 'darwin-arm64'));
    }
    expect(statSync(nodeModulesHelperPath(nodePtyDir, 'darwin-arm64')).mode & 0o777).toBe(0o755);
  });

  test('does NOT throw when the shipped helper is absent — returns ok:false so postinstall stays exit-0', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-x64']);
    const result = ensureNodePtySpawnHelperExecutableInNodeModulesSafe(nodePtyDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/darwin-arm64 spawn-helper missing/);
    }
  });
});

describe('shouldEnsureNodePtySpawnHelper', () => {
  test('runs the spawn-helper chmod only on Darwin', () => {
    expect(shouldEnsureNodePtySpawnHelper('darwin')).toBe(true);
    expect(shouldEnsureNodePtySpawnHelper('linux')).toBe(false);
    expect(shouldEnsureNodePtySpawnHelper('win32')).toBe(false);
  });
});
