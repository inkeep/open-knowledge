import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  linkEditorSkillFolder,
  previewEditorFolderLink,
  unlinkEditorSkillFolder,
} from './skill-folder-links.ts';

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

describe('previewEditorFolderLink (what a LINK would do)', () => {
  /** Every path under `dir`, with symlinks reported as links (not followed). */
  function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const p = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isSymbolicLink()) {
          out.push(`L ${p}`);
          continue;
        }
        out.push(`${e.isDirectory() ? 'D' : 'F'} ${p}`);
        if (e.isDirectory()) walk(p);
      }
    };
    walk('');
    return out;
  }

  test('classifies exactly what the link then does, and writes nothing', () => {
    writeSkill(base, '.codex/skills/only-here', '# A');
    writeSkill(base, '.codex/skills/both', '# Same');
    writeSkill(base, '.agents/skills/both', '# Same');

    const before = tree(base);
    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(tree(base)).toEqual(before);
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    expect(p.plan.toMove).toEqual(['only-here']);
    expect(p.plan.toDrop).toEqual(['both']);
    expect(p.plan.removes).toEqual([]);

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toEqual(p.plan.toMove);
    expect(r.dropped).toEqual(p.plan.toDrop);
  });

  test("names the harness dot-entries the link destroys — they're never moved", () => {
    mkdirSync(join(base, '.codex/skills/foo'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/foo/SKILL.md'), '# foo');
    mkdirSync(join(base, '.codex/skills/.system/imagegen'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/.system/imagegen/SKILL.md'), '# vendor');
    // Benign OS noise stays out of the disclosure — nobody needs consent to
    // lose a `.DS_Store`.
    writeFileSync(join(base, '.codex/skills/.DS_Store'), 'noise');

    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    expect(p.plan.removes).toEqual(['.system']);

    linkEditorSkillFolder({ base, folderRel: '.codex/skills', targetRootRel: '.agents/skills' });
    expect(existsSync(join(base, '.agents/skills/.system'))).toBe(false);
  });

  test('a per-skill delivery link counts as a move, not a silent drop', () => {
    writeSkill(base, '.ok/skills/foreign', '# Canonical');
    mkdirSync(join(base, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(base, '.ok/skills/foreign'), join(base, '.codex/skills/foreign'), 'dir');

    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    // The disclosure folds both lists into one "moves" — a linked bundle that
    // fell out of the plan would under-report what the link touches.
    expect(p.plan.linkedBundlesToMove.map(({ name }) => name)).toEqual(['foreign']);
    expect(p.plan.toMove).toEqual([]);

    const r = linkEditorSkillFolder({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.moved).toEqual(['foreign']);
  });

  test('a skills folder that is its own git repo discloses the .git it will destroy', () => {
    writeSkill(base, '.codex/skills/foo', '# foo');
    mkdirSync(join(base, '.codex/skills/.git/objects'), { recursive: true });
    writeFileSync(join(base, '.codex/skills/.git/HEAD'), 'ref: refs/heads/main');
    // Sibling git dotfiles are recoverable noise and stay silent.
    writeFileSync(join(base, '.codex/skills/.gitignore'), 'node_modules');

    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    expect(p.plan.removes).toEqual(['.git']);

    linkEditorSkillFolder({ base, folderRel: '.codex/skills', targetRootRel: '.agents/skills' });
    // The disclosure has to match what actually happens: the history is gone.
    expect(existsSync(join(base, '.agents/skills/.git'))).toBe(false);
  });

  test('a live delivery link in the TARGET that the merge overwrites is disclosed', () => {
    writeSkill(base, '.ok/skills/shared', '# Delivered');
    writeSkill(base, '.codex/skills/shared', '# Codex own copy');
    mkdirSync(join(base, '.agents', 'skills'), { recursive: true });
    // `.agents/skills/shared` follows `.ok/skills/shared` — exactly what
    // unlinkEditorSkillFolder materializes.
    symlinkSync(join(base, '.ok/skills/shared'), join(base, '.agents/skills/shared'), 'dir');

    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    expect(p.plan.liveDestLinks).toEqual(['shared']);
    expect(p.plan.toMove).toEqual(['shared']);

    linkEditorSkillFolder({ base, folderRel: '.codex/skills', targetRootRel: '.agents/skills' });
    // The delivery is gone: the target now holds codex's real copy, and
    // `.ok/skills/shared` no longer reaches it.
    expect(lstatSync(join(base, '.agents/skills/shared')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(base, '.agents/skills/shared/SKILL.md'), 'utf-8')).toContain(
      '# Codex own copy',
    );
    expect(readFileSync(join(base, '.ok/skills/shared/SKILL.md'), 'utf-8')).toContain(
      '# Delivered',
    );
  });

  test('a DANGLING delivery link in the target is cleanup, not a disclosure', () => {
    writeSkill(base, '.codex/skills/mover', '# Bytes');
    mkdirSync(join(base, '.agents', 'skills'), { recursive: true });
    symlinkSync(join(base, 'gone-away'), join(base, '.agents/skills/mover'), 'dir');

    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('plan');
    if (p.kind !== 'plan') return;
    // Still removed before the rename, but it pointed at nothing — nobody
    // needs to consent to losing it.
    expect(p.plan.destLinks).toEqual(['mover']);
    expect(p.plan.liveDestLinks).toEqual([]);
  });

  test('reports the conflicts that would abort, without writing', () => {
    writeSkill(base, '.codex/skills/fork', '# Mine');
    writeSkill(base, '.agents/skills/fork', '# Theirs DIFFERENT');

    const before = tree(base);
    const p = previewEditorFolderLink({
      base,
      folderRel: '.codex/skills',
      targetRootRel: '.agents/skills',
    });
    expect(tree(base)).toEqual(before);
    expect(p.kind).toBe('conflicts');
    if (p.kind !== 'conflicts') return;
    expect(p.conflicts).toEqual(['fork']);
  });

  test('an absent folder has nothing to disclose', () => {
    const p = previewEditorFolderLink({
      base,
      folderRel: '.cursor/skills',
      targetRootRel: '.agents/skills',
    });
    expect(p.kind).toBe('absent');
    expect(existsSync(join(base, '.cursor'))).toBe(false);
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
