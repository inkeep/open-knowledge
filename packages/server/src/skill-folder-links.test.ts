import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { linkEditorSkillFolder, unlinkEditorSkillFolder } from './skill-folder-links.ts';

function writeSkill(root: string, rel: string, body: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${rel.split('/').pop()}\ndescription: d\n---\n${body}`,
  );
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-folder-link-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('linkEditorSkillFolder (merge-then-swap)', () => {
  test('moves own-only bundles, drops same-hash ones, links the folder', () => {
    writeSkill(base, '.codex/skills/only-here', '# A');
    writeSkill(base, '.codex/skills/both', '# Same');
    writeSkill(base, '.agents/skills/both', '# Same');

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toEqual(['only-here']);
    expect(r.dropped).toEqual(['both']);
    expect(lstatSync(join(base, '.codex/skills')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(base, '.codex/skills'))).toBe(
      realpathSync(join(base, '.agents/skills')),
    );
    expect(readFileSync(join(base, '.agents/skills/only-here/SKILL.md'), 'utf-8')).toContain('# A');
  });

  test('a differing bundle ABORTS the whole merge with nothing written', () => {
    writeSkill(base, '.codex/skills/fork', '# Mine');
    writeSkill(base, '.codex/skills/movable', '# B');
    writeSkill(base, '.agents/skills/fork', '# Theirs DIFFERENT');

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('conflicts');
    expect(r.conflicts).toEqual(['fork']);
    // Abort is a no-op: nothing moved, folder still a real dir.
    expect(lstatSync(join(base, '.codex/skills')).isDirectory()).toBe(true);
    expect(lstatSync(join(base, '.codex/skills')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(base, '.codex/skills/movable/SKILL.md'), 'utf-8')).toContain('# B');
  });

  test('a DANGLING symlink at the merge destination is replaced, not ENOTDIR-crashed', () => {
    writeSkill(base, '.codex/skills/mover', '# Bytes');
    mkdirSync(join(base, '.agents', 'skills'), { recursive: true });
    // Stale pointer at the destination (its target no longer exists).
    symlinkSync(join(base, 'gone-away'), join(base, '.agents/skills/mover'), 'dir');

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toEqual(['mover']);
    expect(lstatSync(join(base, '.agents/skills/mover')).isDirectory()).toBe(true);
    expect(readFileSync(join(base, '.agents/skills/mover/SKILL.md'), 'utf-8')).toContain('# Bytes');
  });

  test('preserves a foreign per-skill delivery link when linking its host folder', () => {
    writeSkill(base, '.ok/skills/foreign', '# Canonical');
    mkdirSync(join(base, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(base, '.ok/skills/foreign'), join(base, '.codex/skills/foreign'), 'dir');

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toEqual(['foreign']);
    expect(lstatSync(join(base, '.agents/skills/foreign')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(base, '.agents/skills/foreign'))).toBe(
      realpathSync(join(base, '.ok/skills/foreign')),
    );
    expect(realpathSync(join(base, '.codex/skills/foreign'))).toBe(
      realpathSync(join(base, '.ok/skills/foreign')),
    );
  });

  test('stray (non-bundle) entries abort; an absent folder links directly', () => {
    mkdirSync(join(base, '.codex/skills'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/notes.txt'), 'stray');
    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stray-entries');

    const r2 = linkEditorSkillFolder({
      base,
      folderRel: '.cursor/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r2.ok).toBe(true);
    expect(lstatSync(join(base, '.cursor/skills')).isSymbolicLink()).toBe(true);
  });

  test("a harness's own bookkeeping in its skills folder does not block LINK", () => {
    mkdirSync(join(base, '.codex/skills/foo'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/foo/SKILL.md'), '# foo');
    // Codex ships its bundled skills under `.system` and leaves an empty
    // runtime dir behind. Neither is content a link could strand, and neither is
    // something the user can clean up — treating them as strays meant this
    // folder could never be linked at all.
    mkdirSync(join(base, '.codex/skills/.system/imagegen'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/.system/imagegen/SKILL.md'), '# vendor');
    mkdirSync(join(base, '.codex/skills/codex-primary-runtime'), { recursive: true });

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    expect(lstatSync(join(base, '.codex/skills')).isSymbolicLink()).toBe(true);
  });

  test('a NON-empty directory without a SKILL.md still blocks LINK', () => {
    mkdirSync(join(base, '.codex/skills/notes'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/notes/thoughts.md'), '# real content');
    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.strays).toContain('notes');
  });

  test('benign dotfiles (.DS_Store) do not count as strays — LINK still succeeds', () => {
    mkdirSync(join(base, '.codex/skills/foo'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/foo/SKILL.md'), '# foo');
    // macOS Finder drops this into any browsed dir; it must not block LINK.
    writeFileSync(join(base, '.codex/skills/.DS_Store'), 'noise');
    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    expect(lstatSync(join(base, '.codex/skills')).isSymbolicLink()).toBe(true);
  });
});

describe('unlinkEditorSkillFolder (materialize as per-skill links)', () => {
  test('replaces the folder link with a real dir of per-skill symlinks', () => {
    writeSkill(base, '.agents/skills/one', '# 1');
    writeSkill(base, '.agents/skills/two', '# 2');
    mkdirSync(join(base, '.codex'), { recursive: true });
    symlinkSync(join(base, '.agents/skills'), join(base, '.codex/skills'), 'dir');

    const r = unlinkEditorSkillFolder({ base, folderRel: '.codex/skills' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.linked.sort()).toEqual(['one', 'two']);
    expect(lstatSync(join(base, '.codex/skills')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(base, '.codex/skills/one')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(base, '.codex/skills/one'))).toBe(
      realpathSync(join(base, '.agents/skills/one')),
    );
  });

  test('exclude leaves the named skill OUT — "this agent should not get that skill"', () => {
    writeSkill(base, '.agents/skills/keep-a', '# A');
    writeSkill(base, '.agents/skills/keep-b', '# B');
    writeSkill(base, '.agents/skills/not-for-codex', '# X');
    mkdirSync(join(base, '.codex'), { recursive: true });
    symlinkSync(join(base, '.agents/skills'), join(base, '.codex/skills'), 'dir');

    const r = unlinkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      exclude: ['not-for-codex'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.linked.sort()).toEqual(['keep-a', 'keep-b']);
    expect(existsSync(join(base, '.codex/skills/not-for-codex'))).toBe(false);
    // The pool keeps the skill — only codex's view dropped it.
    expect(existsSync(join(base, '.agents/skills/not-for-codex/SKILL.md'))).toBe(true);
  });

  test('a real folder refuses to unlink', () => {
    writeSkill(base, '.codex/skills/foo', '# A');
    const r = unlinkEditorSkillFolder({ base, folderRel: '.codex/skills' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-linked');
  });
});
