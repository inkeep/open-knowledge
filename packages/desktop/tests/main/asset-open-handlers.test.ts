import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  extractPathExtension,
  openAssetOrReveal,
  openAssetSafely,
  revealAssetSafely,
} from '../../src/main/asset-allowlist.ts';

const POSIX: NodeJS.Platform = 'linux';

const PROJECT = '/tmp/ok-test-project';

function makeResolver(existingPaths: string[]): (path: string) => string {
  const set = new Set(existingPaths);
  return (path) => {
    if (set.has(path)) return path;
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };
}

function makeStatKind(
  files: string[],
  others: string[] = [],
): (path: string) => 'file' | 'other' | 'missing' {
  const fileSet = new Set(files);
  const otherSet = new Set(others);
  return (path) => {
    if (fileSet.has(path)) return 'file';
    if (otherSet.has(path)) return 'other';
    return 'missing';
  };
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
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/notes/meeting.pdf`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/meeting.pdf',
    );
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(canonical);
  });

  test('path traversal (../../etc/passwd) → path-escape', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: (p) => p,
        statKind: () => 'file',
      },
      '../../etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('absolute path from renderer → path-escape', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: (p) => p,
        statKind: () => 'file',
      },
      '/etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('symlink escape (realpath canonicalizes outside project) → path-escape', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: () => '/etc/passwd',
        statKind: () => 'file',
      },
      'notes/link.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('missing file → not-found (ENOENT from realpath)', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([]),
        statKind: () => 'missing',
      },
      'notes/missing.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('non-ENOENT realpath failure → resolve-error', async () => {
    const openPath = vi.fn(async (_: string) => '');
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
        statKind: () => 'file',
      },
      'notes/restricted.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'resolve-error' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('executable extension (.sh) → extension-blocked even if path is contained + exists', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/notes/setup.sh`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/setup.sh',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('uppercase executable extension (.EXE) is still blocked (case-insensitive)', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/notes/installer.EXE`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/installer.EXE',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('scripted-doc extensions (.html, .svg, .xml) are blocked per stored-XSS defense', async () => {
    const openPath = vi.fn(async (_: string) => '');
    for (const name of ['page.html', 'picture.svg', 'doc.xml', 'email.mhtml']) {
      const canonical = `${PROJECT}/notes/${name}`;
      const result = await openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([canonical]),
          statKind: makeStatKind([canonical]),
        },
        `notes/${name}`,
      );
      expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  test('directory → not-a-file (shell.openPath would launch it)', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/notes/attachments`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([], [canonical]),
      },
      'notes/attachments',
    );
    expect(result).toEqual({ ok: false, reason: 'not-a-file' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('application bundle directory (.app) → not-a-file', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/notes/Calculator.app`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: 'darwin',
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([], [canonical]),
      },
      'notes/Calculator.app',
    );
    expect(result).toEqual({ ok: false, reason: 'not-a-file' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('symlink disguise (photo.png → extensionless run-me) → extension-blocked', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const target = `${PROJECT}/notes/run-me`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: () => target,
        statKind: makeStatKind([target]),
      },
      'notes/photo.png',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('symlink whose target carries a different, unblocked extension → extension-blocked', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const target = `${PROJECT}/notes/report.pdf`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: () => target,
        statKind: makeStatKind([target]),
      },
      'notes/photo.png',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('symlink to a same-extension target opens the canonical target, case-insensitively', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const target = `${PROJECT}/archive/meeting.pdf`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: () => target,
        statKind: makeStatKind([target]),
      },
      'notes/Latest.PDF',
    );
    expect(result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(target);
  });

  test('extensionless regular file (tools/run-me) → extension-blocked', async () => {
    const openPath = vi.fn(async (_: string) => '');
    const canonical = `${PROJECT}/tools/run-me`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'tools/run-me',
    );
    expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('code-running types that launch on open are blocked', async () => {
    const openPath = vi.fn(async (_: string) => '');
    for (const name of [
      'build.tool',
      'run.vbe',
      'panel.cpl',
      'console.msc',
      'help.chm',
      'deploy.application',
      'shortcut.appref-ms',
      'settings.settingcontent-ms',
      'script.py',
      'gui.pyw',
      'module.pyc',
      'app.pyz',
      'gui-app.pyzw',
      'keys.reg',
      'driver.inf',
      'explorer.scf',
      'scriptlet.sct',
      'component.wsc',
      'patch.msp',
      'transform.mst',
      'link.shb',
      'scrap.shs',
    ]) {
      const canonical = `${PROJECT}/notes/${name}`;
      const result = await openAssetSafely(
        {
          projectPath: PROJECT,
          platform: POSIX,
          openPath,
          resolveCanonical: makeResolver([canonical]),
          statKind: makeStatKind([canonical]),
        },
        `notes/${name}`,
      );
      expect(result).toEqual({ ok: false, reason: 'extension-blocked' });
    }
    expect(openPath).not.toHaveBeenCalled();
  });

  test('openPath returning non-empty error string → resolve-error', async () => {
    const openPath = vi.fn(async (_: string) => 'No handler for .foo');
    const canonical = `${PROJECT}/notes/file.foo`;
    const result = await openAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        openPath,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/file.foo',
    );
    expect(result).toEqual({ ok: false, reason: 'resolve-error' });
    expect(openPath).toHaveBeenCalledWith(canonical);
  });
});

describe('openAssetOrReveal (asset context menu)', () => {
  function deps(statKind: (path: string) => 'file' | 'other' | 'missing', osError = '') {
    return {
      projectPath: PROJECT,
      platform: 'darwin' as NodeJS.Platform,
      openPath: vi.fn(async (_: string) => osError),
      showItemInFolder: vi.fn((_: string) => {}),
      resolveCanonical: (p: string) => p,
      statKind,
    };
  }

  test('opens a regular document without revealing it', async () => {
    const d = deps(() => 'file');
    expect(await openAssetOrReveal(d, 'notes/meeting.pdf')).toEqual({ ok: true });
    expect(d.openPath).toHaveBeenCalledWith(`${PROJECT}/notes/meeting.pdf`);
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });

  test('reveals an app bundle instead of opening it', async () => {
    const d = deps(() => 'other');
    expect(await openAssetOrReveal(d, 'tools/Calculator.app')).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
    expect(d.openPath).not.toHaveBeenCalled();
    expect(d.showItemInFolder).toHaveBeenCalledWith(`${PROJECT}/tools/Calculator.app`);
  });

  test('reveals a blocked executable instead of opening it', async () => {
    const d = deps(() => 'file');
    expect(await openAssetOrReveal(d, 'tools/setup.sh')).toEqual({
      ok: false,
      reason: 'extension-blocked',
    });
    expect(d.openPath).not.toHaveBeenCalled();
    expect(d.showItemInFolder).toHaveBeenCalledWith(`${PROJECT}/tools/setup.sh`);
  });

  test('does not reveal when the OS handler itself fails', async () => {
    const d = deps(() => 'file', 'No application knows how to open this');
    expect(await openAssetOrReveal(d, 'notes/file.foo')).toEqual({
      ok: false,
      reason: 'resolve-error',
    });
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });

  test('does not reveal a path outside the project', async () => {
    const d = deps(() => 'file');
    expect(await openAssetOrReveal(d, '../../etc/passwd')).toEqual({
      ok: false,
      reason: 'path-escape',
    });
    expect(d.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('revealAssetSafely (FR-A6; extension blocklist does NOT apply)', () => {
  test('happy path: contained + exists → showItemInFolder fires on canonical', async () => {
    const showItemInFolder = vi.fn((_: string) => {});
    const canonical = `${PROJECT}/notes/meeting.pdf`;
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/meeting.pdf',
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('reveal on an executable is ALLOWED (shell.showItemInFolder opens parent only)', async () => {
    const showItemInFolder = vi.fn((_: string) => {});
    const canonical = `${PROJECT}/notes/setup.sh`;
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([canonical]),
      },
      'notes/setup.sh',
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('reveal on a directory is ALLOWED (only Open in default app refuses non-files)', async () => {
    const showItemInFolder = vi.fn((_: string) => {});
    const canonical = `${PROJECT}/notes/Calculator.app`;
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: 'darwin',
        showItemInFolder,
        resolveCanonical: makeResolver([canonical]),
        statKind: makeStatKind([], [canonical]),
      },
      'notes/Calculator.app',
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(canonical);
  });

  test('path escape still refused', async () => {
    const showItemInFolder = vi.fn((_: string) => {});
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: (p) => p,
        statKind: () => 'file',
      },
      '../../etc/passwd',
    );
    expect(result).toEqual({ ok: false, reason: 'path-escape' });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  test('missing file → not-found', async () => {
    const showItemInFolder = vi.fn((_: string) => {});
    const result = await revealAssetSafely(
      {
        projectPath: PROJECT,
        platform: POSIX,
        showItemInFolder,
        resolveCanonical: makeResolver([]),
        statKind: () => 'missing',
      },
      'notes/missing.pdf',
    );
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('openAssetSafely against the real filesystem', () => {
  let project: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), 'ok-asset-open-')));
    mkdirSync(join(project, 'Calculator.app', 'Contents'), { recursive: true });
    writeFileSync(join(project, 'meeting.pdf'), '%PDF-1.4');
    writeFileSync(join(project, 'run-me'), '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  function open(relPath: string) {
    const openPath = vi.fn(async (_: string) => '');
    const result = openAssetSafely(
      { projectPath: project, platform: process.platform, openPath },
      relPath,
    );
    return { result, openPath };
  }

  test('a regular document opens', async () => {
    const { result, openPath } = open('meeting.pdf');
    expect(await result).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(join(project, 'meeting.pdf'));
  });

  test('an extensionless executable named as itself is refused', async () => {
    const { result, openPath } = open('run-me');
    expect(await result).toEqual({ ok: false, reason: 'extension-blocked' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test('an application bundle directory is refused', async () => {
    const { result, openPath } = open('Calculator.app');
    expect(await result).toEqual({ ok: false, reason: 'not-a-file' });
    expect(openPath).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === 'win32')(
    'a .png symlink to an extensionless executable is refused',
    async () => {
      symlinkSync('run-me', join(project, 'photo.png'));
      const { result, openPath } = open('photo.png');
      expect(await result).toEqual({ ok: false, reason: 'extension-blocked' });
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a .png symlink to a real .pdf is refused',
    async () => {
      symlinkSync('meeting.pdf', join(project, 'cover.png'));
      const { result, openPath } = open('cover.png');
      expect(await result).toEqual({ ok: false, reason: 'extension-blocked' });
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'a .pdf symlink to a directory is refused',
    async () => {
      symlinkSync('Calculator.app', join(project, 'brochure.pdf'));
      const { result, openPath } = open('brochure.pdf');
      expect(await result).toEqual({ ok: false, reason: 'not-a-file' });
      expect(openPath).not.toHaveBeenCalled();
    },
  );
});
