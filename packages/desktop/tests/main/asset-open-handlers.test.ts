/**
 * Unit tests for `openAssetSafely` + `revealAssetSafely`. Covers the
 * three-check gate (containment / existence / extension blocklist) with
 * injected deps so no Electron runtime is required.
 *
 * Paired with the integration test at
 * `packages/desktop/tests/integration/asset-open-ipc.test.ts` which exercises
 * the same handlers through the in-memory IPC bus.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  extractPathExtension,
  openAssetSafely,
  revealAssetSafely,
} from '../../src/main/asset-allowlist.ts';

const POSIX: NodeJS.Platform = 'linux';

// Stand-in for a real project root. The tests inject `resolveCanonical` +
// `statExists` so no actual filesystem touches required.
const PROJECT = '/tmp/ok-test-project';

// Canonical-resolver fake that treats inputs as already-canonical for all
// paths at or under a configurable set, and throws ENOENT otherwise.
function makeResolver(existingPaths: string[]): (path: string) => string {
  const set = new Set(existingPaths);
  return (path) => {
    if (set.has(path)) return path;
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

function makeStatExists(existingPaths: string[]): (path: string) => boolean {
  const set = new Set(existingPaths);
  return (path) => set.has(path);
}

describe('extractPathExtension', () => {
  test('lowercases simple extension', () => {
    expect(extractPathExtension('/tmp/x/meeting.PDF')).toBe('pdf');
  });

  test('returns empty string for extensionless', () => {
    expect(extractPathExtension('/tmp/x/README')).toBe('');
  });

  test('returns empty string for dotfiles (.gitignore → no ext)', () => {
    expect(extractPathExtension('/tmp/x/.gitignore')).toBe('');
  });

  test('handles multi-dot like tarball archive.tar.gz → gz', () => {
    expect(extractPathExtension('/tmp/x/archive.tar.gz')).toBe('gz');
  });

  test('handles Windows-style backslash path', () => {
    expect(extractPathExtension('C:\\Users\\me\\Desktop\\file.PDF')).toBe('pdf');
  });
});

describe('openAssetSafely (FR-A6 + D-A5 + D-A9)', () => {
  test('happy path: contained + exists + non-blocklist → openPath fires', async () => {
    const openPath = mock(async (_: string) => '');
    const canonical = `${PROJECT}/notes/meeting.pdf`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/meeting.pdf',
    );
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(canonical);
  });

  test('path traversal (../../etc/passwd) → path-escape', async () => {
    const openPath = mock(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: (p) => p, // identity — realpath doesn't help if the caller didn't escape
        statExists: () => true,
      },
      '../../etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('absolute path from renderer → path-escape', async () => {
    const openPath = mock(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: (p) => p,
        statExists: () => true,
      },
      '/etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('symlink escape (realpath canonicalizes outside project) → path-escape', async () => {
    const openPath = mock(async (_: string) => '');
    // Simulate: project has `notes/link.pdf` which is a symlink to /etc/passwd
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        // realpath resolves the symlink to /etc/passwd — outside project
        resolveCanonical: () => '/etc/passwd',
        statExists: () => true,
      },
      'notes/link.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('missing file → not-found (ENOENT from realpath)', async () => {
    const openPath = mock(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([]), // empty set → ENOENT
        statExists: () => false,
      },
      'notes/missing.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('non-ENOENT realpath failure → resolve-error', async () => {
    const openPath = mock(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: () => {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        },
        statExists: () => true,
      },
      'notes/restricted.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'resolve-error' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('executable extension (.sh) → extension-blocked even if path is contained + exists', async () => {
    const openPath = mock(async (_: string) => '');
    const canonical = `${PROJECT}/notes/setup.sh`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/setup.sh',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('uppercase executable extension (.EXE) is still blocked (case-insensitive)', async () => {
    const openPath = mock(async (_: string) => '');
    const canonical = `${PROJECT}/notes/installer.EXE`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/installer.EXE',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('scripted-doc extensions (.html, .svg, .xml) are blocked per stored-XSS defense', async () => {
    const openPath = mock(async (_: string) => '');
    for (const name of ['page.html', 'picture.svg', 'doc.xml', 'email.mhtml']) {
      const canonical = `${PROJECT}/notes/${name}`;
      const result = await openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([canonical]),
          statExists: makeStatExists([canonical]),
        },
        `notes/${name}`,
      );
      expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  test('openPath returning non-empty error string → resolve-error', async () => {
    // shell.openPath returns a non-empty string when the OS handler refuses
    // the dispatch — e.g. "No application is associated with .foo files"
    const openPath = mock(async (_: string) => 'No handler for .foo');
    const canonical = `${PROJECT}/notes/file.foo`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/file.foo',
    );
    expect(result).toEqual({ ok: false, reason: 'resolve-error' });
    expect(openPath).toHaveBeenCalledWith(canonical);
  });
});

describe('revealAssetSafely (FR-A6; extension blocklist does NOT apply)', () => {
  test('happy path: contained + exists → showItemInFolder fires on canonical', async () => {
    const showItemInFolder = mock((_: string) => {});
    const canonical = `${PROJECT}/notes/meeting.pdf`;
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/meeting.pdf',
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('reveal on an executable is ALLOWED (shell.showItemInFolder opens parent only)', async () => {
    const showItemInFolder = mock((_: string) => {});
    const canonical = `${PROJECT}/notes/setup.sh`;
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([canonical]),
        statExists: makeStatExists([canonical]),
      },
      'notes/setup.sh',
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('path escape still refused', async () => {
    const showItemInFolder = mock((_: string) => {});
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: (p) => p,
        statExists: () => true,
      },
      '../../etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  test('missing file → not-found', async () => {
    const showItemInFolder = mock((_: string) => {});
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([]),
        statExists: () => false,
      },
      'notes/missing.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
