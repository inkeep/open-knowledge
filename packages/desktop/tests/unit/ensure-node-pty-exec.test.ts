import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNodePtySpawnHelperExecutable } from '../../scripts/ensure-node-pty-exec.mjs';


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
    expect(statSync(helper).mode & 0o111).toBe(0); // no execute bits to start

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
    const resourcesDir = makeResourcesFixture(['darwin-x64']); // arm64 helper missing
    expect(() => ensureNodePtySpawnHelperExecutable(resourcesDir)).toThrow(
      /darwin-arm64 spawn-helper missing/,
    );
  });
});
