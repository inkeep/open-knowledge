import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
  // The classifier is the single decision every route catch keys 400-vs-500 on,
  // so the membership itself is the contract: both containment halves are in,
  // the missing-anchor server fault is out.
  test('admits both containment halves and rejects everything else', () => {
    expect(isContainmentRejection(new PathContainmentError('path must be relative'))).toBe(true);
    expect(isContainmentRejection(new SymlinkEscapeError('path resolves outside'))).toBe(true);
    expect(isContainmentRejection(new ContentRootUnavailableError('content dir gone'))).toBe(false);
    expect(isContainmentRejection(new Error('EACCES: permission denied'))).toBe(false);
    expect(isContainmentRejection(undefined)).toBe(false);
  });

  test('a missing content dir throws the non-containment ContentRootUnavailableError', () => {
    // The anchor itself being absent is a SERVER condition (dir deleted under a
    // running server, unmounted volume) — routes must surface it as a 500, so
    // it must NOT classify as a containment rejection.
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

describe('canonicalRelPathForNewTarget', () => {
  const log = loggerFactory.getLogger('test');
  const errno = (code: string): NodeJS.ErrnoException => {
    const e = new Error(`${code}: injected`) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };

  // The return value feeds `isReservedProjectStatePath`, which splits on `/`,
  // so the helper's postcondition is a `/`-separated path on every platform.
  // The POSIX tests pin the branch logic + reattachment; the win32 tests below
  // drive the injected `win32` path flavor from this (Linux) runner, since the
  // CI matrix has no Windows cell running this suite.

  test('ascends past a missing leaf and canonicalizes through a symlinked ancestor', () => {
    // `/c/sneaky` is a symlink to `/c/.ok`; the target file does not exist yet.
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
    // `path.win32.relative` joins with `\`; without the toPosix normalization the
    // consumer `isReservedProjectStatePath` (which splits on `/`) sees one opaque
    // segment and the guard is silently inert on Windows. The second assertion is
    // the load-bearing producer→consumer contract: it goes red the instant a
    // `toPosix` call is dropped.
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
    // The bootstrap window: nothing in the ancestor chain realpaths (content
    // dir not created yet), so the helper falls back to the lexical relative
    // path via the third exit. Same producer→consumer assertion as above —
    // dropping the toPosix wrapper from that exit alone must go red here.
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
