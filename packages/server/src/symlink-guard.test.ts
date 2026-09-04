import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SymlinkEscapeError } from './apply-managed-rename.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

describe('assertRealpathWithinDir', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'symlink-guard-'));
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

describe('assertRealpathWithinDir — shareable .ok exemption', () => {
  let root: string;
  const opts = { allowShareableOkArtifact: isShareableOkArtifact };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'symlink-guard-ok-'));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(root, '.git', 'config'), '[core]\n');
    mkdirSync(join(root, '.ok', 'local'), { recursive: true });
    writeFileSync(join(root, '.ok', 'local', 'config.yml'), 'autoSync:\n  mode: full\n');
    mkdirSync(join(root, '.ok', 'templates'), { recursive: true });
    mkdirSync(join(root, 'notes'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('allows an existing shareable artifact', () => {
    writeFileSync(join(root, '.ok', 'config.yml'), 'shared: base\n');
    expect(() =>
      assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root, opts),
    ).not.toThrow();
  });

  it('allows a shareable artifact that does not exist yet', () => {
    expect(() =>
      assertRealpathWithinDir(join(root, '.ok', 'templates', 'project.md'), root, opts),
    ).not.toThrow();
  });

  it('refuses a symlink NAMED like a shareable artifact that resolves to private .ok state', () => {
    symlinkSync('./local/config.yml', join(root, '.ok', 'config.yml'));
    expect(() => assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root, opts)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses a DANGLING shareable-named symlink into private .ok state', () => {
    symlinkSync('./local/not-yet-created.yml', join(root, '.ok', 'config.yml'));
    expect(() => assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root, opts)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses a shareable-named symlink into .git even with a permissive predicate', () => {
    symlinkSync('../.git/hooks/post-checkout', join(root, '.ok', 'config.yml'));
    expect(() =>
      assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root, {
        allowShareableOkArtifact: () => true,
      }),
    ).toThrow(SymlinkEscapeError);
  });

  it('refuses a content-named symlink resolving to private .ok state', () => {
    symlinkSync('../.ok/local/config.yml', join(root, 'notes', 'innocent.md'));
    expect(() => assertRealpathWithinDir(join(root, 'notes', 'innocent.md'), root, opts)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('still refuses every .ok path when no predicate is passed', () => {
    writeFileSync(join(root, '.ok', 'config.yml'), 'shared: base\n');
    expect(() => assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('still refuses escapes outside the root regardless of the predicate', () => {
    symlinkSync(join(tmpdir(), 'outside.yml'), join(root, '.ok', 'config.yml'));
    expect(() =>
      assertRealpathWithinDir(join(root, '.ok', 'config.yml'), root, {
        allowShareableOkArtifact: () => true,
      }),
    ).toThrow(SymlinkEscapeError);
  });
});

describe('assertRealpathWithinDir — case-folded state-dir refusal', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'symlink-guard-case-'));
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    mkdirSync(join(root, 'notes'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses an uppercase .OK leaf with no existing ancestor', () => {
    expect(() => assertRealpathWithinDir(join(root, '.OK', 'local', 'evil.yml'), root)).toThrow(
      SymlinkEscapeError,
    );
  });

  it('refuses an uppercase .GIT leaf regardless of filesystem case behavior', () => {
    expect(() =>
      assertRealpathWithinDir(join(root, '.GIT', 'hooks', 'post-checkout'), root),
    ).toThrow(SymlinkEscapeError);
  });

  it('never case-folds into the shareable EXEMPTION', () => {
    expect(() =>
      assertRealpathWithinDir(join(root, '.OK', 'config.yml'), root, {
        allowShareableOkArtifact: isShareableOkArtifact,
      }),
    ).toThrow(SymlinkEscapeError);
  });
});
