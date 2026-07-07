import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveHarnessWritePaths, type SymlinkWritePaths } from './symlink-resolve.ts';

// One contract suite run against BOTH backends — the pure-JS mirror and the
// native (conformance-tested) resolver loaded from the built `.node` — so the
// two implementations cannot drift: any divergence in chain-following or
// cycle-breaking fails the same assertions for one backend but not the other.
// The native binding is hard-required (not skipped when absent) so a gate that
// failed to build the addon fails loudly, matching the sibling binding tests.

interface NativeSymlinkBinding {
  resolveSymlinkWritePath(path: string): { readPath?: string | null; writePath: string };
}

const require = createRequire(import.meta.url);
const nativeBinding = require('@inkeep/open-knowledge-native-config') as NativeSymlinkBinding;

const unix = process.platform !== 'win32';

function describeResolver(label: string, resolve: (path: string) => SymlinkWritePaths) {
  describe(`symlink write-path resolver (${label})`, () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ok-symlink-resolve-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test('a regular file resolves to itself', () => {
      const path = join(dir, 'config.toml');
      writeFileSync(path, 'x = 1\n');
      const resolved = resolve(path);
      expect(resolved.writePath).toBe(path);
      expect(resolved.readPath).toBe(path);
    });

    test('a not-yet-created file resolves to itself (first write)', () => {
      const path = join(dir, 'config.toml');
      const resolved = resolve(path);
      expect(resolved.writePath).toBe(path);
      expect(resolved.readPath).toBe(path);
    });

    test.skipIf(!unix)(
      'follows a chain to its real target, keeping the target as both paths',
      () => {
        const targetDir = mkdtempSync(join(tmpdir(), 'ok-symlink-target-'));
        try {
          const target = join(targetDir, 'real-config.toml');
          writeFileSync(target, 'model = "x"\n');
          const link = join(dir, 'link.toml');
          const config = join(dir, 'config.toml');
          symlinkSync(target, link); // absolute target
          symlinkSync('link.toml', config); // relative hop within the dir

          const resolved = resolve(config);
          expect(resolved.writePath).toBe(target);
          expect(resolved.readPath).toBe(target);
        } finally {
          rmSync(targetDir, { recursive: true, force: true });
        }
      },
    );

    test.skipIf(!unix)('resolves a relative link against its own parent', () => {
      const target = join(dir, 'target.toml');
      writeFileSync(target, 'model = "x"\n');
      const config = join(dir, 'config.toml');
      symlinkSync('target.toml', config);

      const resolved = resolve(config);
      expect(resolved.writePath).toBe(target);
      expect(resolved.readPath).toBe(target);
    });

    test.skipIf(!unix)('breaks a cycle: no read target, writes through the original path', () => {
      // config -> a -> b -> a loops; the resolver declines a read target and
      // writes a fresh regular file at the original path to break the link.
      symlinkSync('b.toml', join(dir, 'a.toml'));
      symlinkSync('a.toml', join(dir, 'b.toml'));
      const config = join(dir, 'config.toml');
      symlinkSync('a.toml', config);

      const resolved = resolve(config);
      expect(resolved.readPath).toBeNull();
      expect(resolved.writePath).toBe(config);
    });
  });
}

describeResolver('js fallback', (path) => resolveHarnessWritePaths(path, () => null));
describeResolver('native', (path) => resolveHarnessWritePaths(path, () => nativeBinding));

describe('resolveHarnessWritePaths backend selection', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-symlink-backend-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('degrades to the JS mirror when the native binding throws', () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'x = 1\n');
    const throwingBinding: NativeSymlinkBinding = {
      resolveSymlinkWritePath() {
        throw new Error('binding cannot execute');
      },
    };
    const resolved = resolveHarnessWritePaths(path, () => throwingBinding);
    expect(resolved.writePath).toBe(path);
    expect(resolved.readPath).toBe(path);
  });
});
