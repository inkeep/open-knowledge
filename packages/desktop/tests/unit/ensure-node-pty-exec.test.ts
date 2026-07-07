import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureNodePtySpawnHelperExecutable,
  ensureNodePtySpawnHelperExecutableInNodeModules,
  ensureNodePtySpawnHelperExecutableInNodeModulesSafe,
} from '../../scripts/ensure-node-pty-exec.mjs';

/**
 * Behavioral coverage for the afterPack spawn-helper chmod. node-pty's prebuilt
 * spawn-helper ships mode 0644; asarUnpack preserves that, so without this chmod
 * the packaged terminal dies with "posix_spawnp failed" (node-pty#850). We
 * exercise the real filesystem mode bits against a fixture mirroring the packed
 * `Contents/Resources/app.asar.unpacked/...` layout — no mocks.
 */

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
    // Mirror node-pty's shipped non-executable mode so the chmod has work to do.
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

/**
 * Behavioral coverage for the dev/CI build+install path — the analog of the
 * afterPack chmod above. `bun install` lands node-pty's prebuilt spawn-helper
 * non-executable under the real `node_modules/node-pty/prebuilds/...` tree, and
 * the dev build (`bun run build:desktop`, electron-vite, no afterPack) has no
 * step to fix it, so the in-app terminal dies with "posix_spawnp failed". The
 * desktop postinstall runs this against the real `node_modules` layout; we
 * exercise the real mode bits against a fixture mirroring it — no mocks.
 */

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
    // Mirror the non-executable mode bun install leaves behind.
    chmodSync(helper, 0o644);
  }
  return nodePtyDir;
}

describe('ensureNodePtySpawnHelperExecutableInNodeModules', () => {
  test('promotes the shipped darwin-arm64 spawn-helper from 0644 to executable 0755', () => {
    const nodePtyDir = makeNodeModulesFixture(['darwin-arm64']);
    const helper = nodeModulesHelperPath(nodePtyDir, 'darwin-arm64');
    expect(statSync(helper).mode & 0o111).toBe(0); // no execute bits to start

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
    const nodePtyDir = makeNodeModulesFixture(['darwin-x64']); // arm64 helper missing
    expect(() => ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir)).toThrow(
      /darwin-arm64 spawn-helper missing/,
    );
  });
});

/**
 * The postinstall's non-throwing contract: a pathological node-pty layout must NEVER
 * fail `bun install` (that would gate the whole monorepo). The Safe wrapper converts
 * the hard-error throw above into an `{ ok: false, error }` result so the postinstall
 * caller stays exit-0. Pinned here so a refactor that drops the swallowing regresses.
 */
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
    // arm64 helper missing -> the underlying ...InNodeModules throws; Safe must swallow it.
    // Calling it directly: if Safe re-threw, this test would error rather than assert.
    const nodePtyDir = makeNodeModulesFixture(['darwin-x64']);
    const result = ensureNodePtySpawnHelperExecutableInNodeModulesSafe(nodePtyDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/darwin-arm64 spawn-helper missing/);
    }
  });
});
