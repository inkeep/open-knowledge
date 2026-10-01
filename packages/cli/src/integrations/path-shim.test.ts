import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathShimBlockLabel, pathShimFishConfFileName } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  extraSymlinkStillOurs,
  PATH_SHIM_BEGIN,
  PATH_SHIM_END,
  pathInstallMarkerPath,
  pathShimFishConfName,
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
      expect(extraSymlinkStillOurs(link, join(dir, 'somewhere-else'))).toBe(false);
      const plain = join(dir, 'plain');
      writeFileSync(plain, 'x');
      expect(extraSymlinkStillOurs(plain, target)).toBe(false);
      expect(extraSymlinkStillOurs(join(dir, 'missing'), target)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('path shim per channel', () => {
  const BETA_BLOCK =
    '# >>> open-knowledge beta cli >>>\n[ -f "$HOME/.ok-beta/env.sh" ] && . "$HOME/.ok-beta/env.sh"\n# <<< open-knowledge beta cli <<<\n';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('Stable keeps its Application Support marker and strips only the Stable block', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(pathInstallMarkerPath('/home/me')).toBe(
      join('/home/me', 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json'),
    );
    const { text } = stripManagedPathBlock(`${block()}${BETA_BLOCK}`);
    expect(text).toBe(BETA_BLOCK);
  });

  test('Beta reads its marker under ~/.ok-beta and strips only the Beta block', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(pathInstallMarkerPath('/home/me')).toBe(
      join('/home/me', '.ok-beta', 'path-install.json'),
    );
    const { text, changed } = stripManagedPathBlock(`${block()}${BETA_BLOCK}`);
    expect(changed).toBe(true);
    expect(text).toBe(block());
  });

  test('Beta removes the fish file and block the desktop installer writes', () => {
    vi.stubEnv('OK_CHANNEL', 'beta');
    expect(pathShimFishConfName()).toBe(pathShimFishConfFileName('beta'));
    expect(pathShimFishConfName()).toBe('open-knowledge-beta.fish');
    const label = pathShimBlockLabel('beta');
    expect(label).toBe('open-knowledge beta cli');
    const fish = `# >>> ${label} >>>\nset -gx PATH "$HOME/.ok-beta/bin" $PATH\n# <<< ${label} <<<\n`;
    expect(stripManagedPathBlock(fish)).toEqual({ text: '', changed: true, emptyAfter: true });
  });

  test('Stable keeps its fish file name', () => {
    vi.stubEnv('OK_CHANNEL', 'stable');
    expect(pathShimFishConfName()).toBe('open-knowledge.fish');
  });
});
