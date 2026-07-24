import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymlinkEscapeError } from './apply-managed-rename.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

describe('assertRealpathWithinDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'symlink-guard-'));
    // Shape a realistic project: a git dir with the default (inactive) sample
    // hooks git actually ships, an .ok state dir, and a content sub-folder.
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    mkdirSync(join(root, '.ok', 'local'), { recursive: true });
    writeFileSync(join(root, '.ok', 'local', 'config.yml'), 'autoSync:\n  mode: full\n');
    mkdirSync(join(root, 'notes'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a plain content path that does not exist yet', () => {
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'new.md'), root)).not.toThrow();
  });

  it('passes a symlink that resolves to a sibling content file', () => {
    writeFileSync(join(root, 'notes', 'real.md'), '# real\n');
    symlinkSync('./real.md', join(root, 'notes', 'link.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'link.md'), root)).not.toThrow();
  });

  it('refuses a DANGLING symlink pointing into .git/hooks (git ships only *.sample, so the hook file is absent)', () => {
    // The realistic attack: an upstream commits notes/daily.md as a symlink to
    // .git/hooks/post-checkout. git ships post-checkout.sample, not post-checkout,
    // so the target is absent and realpath cannot resolve it — the write would
    // CREATE an executable hook. Must be refused before the write.
    symlinkSync('../.git/hooks/post-checkout', join(root, 'notes', 'daily.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'daily.md'), root)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses an EXISTING symlink pointing into .git', () => {
    symlinkSync('../.git/config', join(root, 'notes', 'gitcfg.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'gitcfg.md'), root)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses a symlink pointing into the .ok state dir (config hijack)', () => {
    symlinkSync('../.ok/local/config.yml', join(root, 'notes', 'okcfg.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'okcfg.md'), root)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses a symlink that escapes the root entirely (existing containment)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'symlink-guard-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'notes', 'escape.md'));
      expect(() => assertRealpathWithinDir(join(root, 'notes', 'escape.md'), root)).toThrow(
        SymlinkEscapeError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a DANGLING symlink that escapes the root (absent target outside root)', () => {
    symlinkSync(resolve(root, '..', 'nonexistent-outside-target'), join(root, 'notes', 'esc2.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'esc2.md'), root)).toThrow(
      SymlinkEscapeError,
    );
  });
});
