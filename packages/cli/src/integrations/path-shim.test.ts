import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extraSymlinkStillOurs,
  PATH_SHIM_BEGIN,
  PATH_SHIM_END,
  pathInstallMarkerPath,
  readPathInstallMarker,
  stripManagedPathBlock,
} from './path-shim.ts';

function block(inner = '[ -f "$HOME/.ok/env.sh" ] && . "$HOME/.ok/env.sh"'): string {
  return `${PATH_SHIM_BEGIN}\n${inner}\n${PATH_SHIM_END}\n`;
}

describe('stripManagedPathBlock', () => {
  test('strips the block from a user rc file, preserving every other line', () => {
    const before = `export EDITOR=vim\n\n${block()}\nalias ll='ls -la'\n`;
    const { text, changed, emptyAfter } = stripManagedPathBlock(before);
    expect(changed).toBe(true);
    expect(emptyAfter).toBe(false);
    expect(text).toContain('export EDITOR=vim');
    expect(text).toContain("alias ll='ls -la'");
    expect(text).not.toContain(PATH_SHIM_BEGIN);
    expect(text).not.toContain(PATH_SHIM_END);
  });

  test('reports emptyAfter for an OK-owned file whose only content is the block', () => {
    // The fish conf file is created solely by OK — after stripping there is
    // nothing left, so the caller deletes the file rather than leave it blank.
    const { text, changed, emptyAfter } = stripManagedPathBlock(block());
    expect(changed).toBe(true);
    expect(emptyAfter).toBe(true);
    expect(text.trim()).toBe('');
  });

  test('is a no-op for a file with no managed block', () => {
    const before = 'export PATH="$HOME/bin:$PATH"\n';
    const { text, changed, emptyAfter } = stripManagedPathBlock(before);
    expect(changed).toBe(false);
    expect(emptyAfter).toBe(false);
    expect(text).toBe(before);
  });
});

describe('readPathInstallMarker', () => {
  test('reads a valid v1 marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-marker-'));
    try {
      const markerPath = pathInstallMarkerPath(home);
      const dir = markerPath.slice(0, markerPath.lastIndexOf('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({
          version: 1,
          installedAt: 'x',
          bundleVersion: '1.0.0',
          bundleWrapperPath: '/w',
          binDir: join(home, '.ok', 'bin'),
          envShimPath: join(home, '.ok', 'env.sh'),
          rcFiles: [join(home, '.zshrc')],
          rcOptOuts: [],
          pathDiscovery: null,
          extraSymlinks: [],
        }),
      );
      const marker = readPathInstallMarker(home);
      expect(marker?.version).toBe(1);
      expect(marker?.rcFiles).toEqual([join(home, '.zshrc')]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('returns null for an absent, malformed, or wrong-version marker', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-marker-'));
    try {
      expect(readPathInstallMarker(home)).toBeNull();
      const markerPath = pathInstallMarkerPath(home);
      const dir = markerPath.slice(0, markerPath.lastIndexOf('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(markerPath, 'not json');
      expect(readPathInstallMarker(home)).toBeNull();
      writeFileSync(markerPath, JSON.stringify({ version: 2 }));
      expect(readPathInstallMarker(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('extraSymlinkStillOurs', () => {
  test('true only when the path is a symlink still pointing at the recorded target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-xsym-'));
    try {
      const target = join(dir, '.ok', 'bin', 'ok');
      const link = join(dir, 'ok');
      symlinkSync(target, link);
      expect(extraSymlinkStillOurs(link, target)).toBe(true);
      // Re-pointed → no longer ours.
      expect(extraSymlinkStillOurs(link, join(dir, 'somewhere-else'))).toBe(false);
      // A regular file at the path → not a symlink.
      const plain = join(dir, 'plain');
      writeFileSync(plain, 'x');
      expect(extraSymlinkStillOurs(plain, target)).toBe(false);
      // Missing path.
      expect(extraSymlinkStillOurs(join(dir, 'missing'), target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
