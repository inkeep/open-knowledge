import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isReservedProjectStatePath } from './content/managed-doc-enum.ts';
import {
  assertNoSymlinkEscape,
  ContentRootUnavailableError,
  canonicalRelPathForNewTarget,
  isContainmentRejection,
  PathContainmentError,
  SymlinkEscapeError,
} from './fs-safety.ts';
import { loggerFactory } from './logger.ts';

describe('containment error family classification', () => {
  test('admits both containment halves and rejects everything else', () => {
    expect(isContainmentRejection(new PathContainmentError('path must be relative'))).toBe(true);
    expect(isContainmentRejection(new SymlinkEscapeError('path resolves outside'))).toBe(true);
    expect(isContainmentRejection(new ContentRootUnavailableError('content dir gone'))).toBe(false);
    expect(isContainmentRejection(new Error('EACCES: permission denied'))).toBe(false);
    expect(isContainmentRejection(undefined)).toBe(false);
  });

  test('a missing content dir throws the non-containment ContentRootUnavailableError', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-safety-'));
    try {
      const missingAnchor = join(root, 'never-created');
      let caught: unknown;
      try {
        assertNoSymlinkEscape(join(missingAnchor, 'doc.md'), missingAnchor);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ContentRootUnavailableError);
      expect(isContainmentRejection(caught)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an out-of-root symlink throws the containment SymlinkEscapeError', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-safety-'));
    try {
      const contentDir = join(root, 'content');
      const outside = join(root, 'outside');
      mkdirSync(contentDir);
      mkdirSync(outside);
      symlinkSync(outside, join(contentDir, 'esc'), 'dir');
      let caught: unknown;
      try {
        assertNoSymlinkEscape(join(contentDir, 'esc', 'doc.md'), contentDir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SymlinkEscapeError);
      expect(isContainmentRejection(caught)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('assertNoSymlinkEscape refuses links into private repository state', () => {
  function withRepo(run: (contentDir: string) => void): void {
    const contentDir = mkdtempSync(join(tmpdir(), 'fs-safety-private-'));
    try {
      for (const dir of ['.ok/local', '.ok/templates', '.git', 'notes', 'shared', 'docs/.ok']) {
        mkdirSync(join(contentDir, dir), { recursive: true });
      }
      writeFileSync(join(contentDir, '.ok/local/principal.json'), '{"secret":true}');
      writeFileSync(join(contentDir, '.ok/config.yml'), '');
      writeFileSync(join(contentDir, '.ok/templates/t.md'), '# T');
      writeFileSync(join(contentDir, '.git/config'), '[core]');
      writeFileSync(join(contentDir, 'shared/a.md'), '# A');
      run(contentDir);
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  }

  const refusal = (path: string, contentDir: string): unknown => {
    try {
      assertNoSymlinkEscape(path, contentDir);
      return null;
    } catch (e) {
      return e;
    }
  };

  test.each([
    [
      'a file link to machine-local state',
      'notes/leak.md',
      '../.ok/local/principal.json',
      'notes/leak.md',
    ],
    ['a file link to the git config', 'notes/cfg.md', '../.git/config', 'notes/cfg.md'],
    ['a link to the config dir itself', 'notes/ok', '../.ok', 'notes/ok'],
    [
      'a descent into .git through a link to the root',
      'notes/root',
      '..',
      'notes/root/.git/config',
    ],
    ['a new file under a link into .git', 'notes/hooks', '../.git', 'notes/hooks/new.md'],
  ])('%s is refused', (_label, link, target, requested) => {
    withRepo((contentDir) => {
      symlinkSync(target, join(contentDir, link));
      const caught = refusal(join(contentDir, requested), contentDir);
      expect(caught).toBeInstanceOf(SymlinkEscapeError);
      expect(isContainmentRejection(caught)).toBe(true);
    });
  });

  test.each([
    ['the config file', '.ok/config.yml'],
    ['the templates dir', '.ok/templates'],
    ['a nested folder config dir', 'docs/.ok'],
    ['a missing nested folder config dir', 'notes/.ok'],
  ])('direct access to %s still passes', (_label, requested) => {
    withRepo((contentDir) => {
      expect(refusal(join(contentDir, requested), contentDir)).toBeNull();
    });
  });

  test('in-root links to ordinary content still pass', () => {
    withRepo((contentDir) => {
      symlinkSync('../shared/a.md', join(contentDir, 'notes/alias.md'));
      symlinkSync('../shared', join(contentDir, 'notes/shared-dir'));
      expect(refusal(join(contentDir, 'notes/alias.md'), contentDir)).toBeNull();
      expect(refusal(join(contentDir, 'notes/shared-dir/a.md'), contentDir)).toBeNull();
    });
  });

  test("a symlinked folder's own config dir classifies like the folder it links to", () => {
    withRepo((contentDir) => {
      symlinkSync('../docs', join(contentDir, 'notes/docs-link'));
      expect(refusal(join(contentDir, 'notes/docs-link/.ok'), contentDir)).toBeNull();
      expect(
        refusal(join(contentDir, 'notes/docs-link/.ok/frontmatter.yml'), contentDir),
      ).toBeNull();
    });
  });

  test('a link whose own target is a config dir stays refused', () => {
    withRepo((contentDir) => {
      symlinkSync('../docs/.ok', join(contentDir, 'notes/cfg'));
      expect(refusal(join(contentDir, 'notes/cfg'), contentDir)).toBeInstanceOf(SymlinkEscapeError);
    });
  });
});

describe('canonicalRelPathForNewTarget', () => {
  const log = loggerFactory.getLogger('test');
  const errno = (code: string): NodeJS.ErrnoException => {
    const e = new Error(`${code}: injected`) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };

  test('ascends past a missing leaf and canonicalizes through a symlinked ancestor', () => {
    const realpath = ((p: string): string => {
      if (p === '/c') return '/c';
      if (p === '/c/sneaky') return '/c/.ok';
      throw errno('ENOENT');
    }) as unknown as typeof import('node:fs').realpathSync;
    expect(canonicalRelPathForNewTarget('/c/sneaky/phantom.md', '/c', log, realpath)).toBe(
      '.ok/phantom.md',
    );
  });

  test('falls back to the lexical relative path on a raw realpath errno', () => {
    const realpath = ((): string => {
      throw errno('EACCES');
    }) as unknown as typeof import('node:fs').realpathSync;
    expect(canonicalRelPathForNewTarget('/c/notes/x.md', '/c', log, realpath)).toBe('notes/x.md');
  });

  test('falls back to the lexical relative path when ENOENT reaches the filesystem root', () => {
    const realpath = ((): string => {
      throw errno('ENOENT');
    }) as unknown as typeof import('node:fs').realpathSync;
    expect(canonicalRelPathForNewTarget('/c/a/b/x.md', '/c', log, realpath)).toBe('a/b/x.md');
  });

  test('win32: a symlinked-ancestor result still satisfies the /-split consumer', () => {
    const realpath = ((p: string): string => {
      if (p === 'C:\\c') return 'C:\\c';
      if (p === 'C:\\c\\sneaky') return 'C:\\c\\.ok';
      throw errno('ENOENT');
    }) as unknown as typeof import('node:fs').realpathSync;
    const out = canonicalRelPathForNewTarget('C:\\c\\sneaky\\phantom.md', 'C:\\c', log, realpath, {
      join: win32.join,
      relative: win32.relative,
      dirname: win32.dirname,
      sep: win32.sep,
    });
    expect(out).toBe('.ok/phantom.md');
    expect(isReservedProjectStatePath(out)).toBe(true);
  });

  test('win32: the raw-errno lexical fallback is also /-normalized', () => {
    const realpath = ((): string => {
      throw errno('EACCES');
    }) as unknown as typeof import('node:fs').realpathSync;
    const out = canonicalRelPathForNewTarget('C:\\c\\.ok\\x.md', 'C:\\c', log, realpath, {
      join: win32.join,
      relative: win32.relative,
      dirname: win32.dirname,
      sep: win32.sep,
    });
    expect(out).toBe('.ok/x.md');
    expect(isReservedProjectStatePath(out)).toBe(true);
  });

  test('win32: the ENOENT-to-filesystem-root fallback is also /-normalized', () => {
    const realpath = ((): string => {
      throw errno('ENOENT');
    }) as unknown as typeof import('node:fs').realpathSync;
    const out = canonicalRelPathForNewTarget('C:\\c\\.ok\\deep\\x.md', 'C:\\c', log, realpath, {
      join: win32.join,
      relative: win32.relative,
      dirname: win32.dirname,
      sep: win32.sep,
    });
    expect(out).toBe('.ok/deep/x.md');
    expect(isReservedProjectStatePath(out)).toBe(true);
  });
});
