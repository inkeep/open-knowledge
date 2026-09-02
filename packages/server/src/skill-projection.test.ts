import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  hostSkillsRootEscapes,
  projectInPlaceSkill,
  projectSkill,
  readSkillBundledFiles,
  relocateInPlaceCanonical,
  removeInPlaceSkillCopies,
  reverseProjectSkill,
  skillHostDir,
  validateSkillForInstall,
} from './skill-projection.ts';

let root: string;

function makeSkill(
  name: string,
  body: string,
  frontmatter = `name: ${name}\ndescription: Use when testing.`,
) {
  const dir = join(root, '.ok', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf-8');
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-projection-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('validateSkillForInstall', () => {
  test('valid skill passes', () => {
    const dir = makeSkill('trip-log', '# Steps');
    const v = validateSkillForInstall(dir, 'trip-log');
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.hasScripts).toBe(false);
  });

  test('rejects git conflict markers', () => {
    const dir = makeSkill('conflicted', '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch');
    const v = validateSkillForInstall(dir, 'conflicted');
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('conflict markers'))).toBe(true);
  });

  test('rejects reserved open-knowledge* prefix unless allowed', () => {
    const dir = makeSkill(
      'open-knowledge-mine',
      '# x',
      'name: open-knowledge-mine\ndescription: d',
    );
    expect(validateSkillForInstall(dir, 'open-knowledge-mine').ok).toBe(false);
    expect(
      validateSkillForInstall(dir, 'open-knowledge-mine', { allowReservedName: true }).ok,
    ).toBe(true);
  });

  test('the exact LEGACY pack names stay installable; unknown pack-prefixed names stay rejected', () => {
    const legacy = 'open-knowledge-pack-knowledge-base';
    const legacyDir = makeSkill(legacy, '# x', `name: ${legacy}\ndescription: d`);
    expect(validateSkillForInstall(legacyDir, legacy).ok).toBe(true);
    const unknown = 'open-knowledge-pack-something-else';
    const unknownDir = makeSkill(unknown, '# x', `name: ${unknown}\ndescription: d`);
    expect(validateSkillForInstall(unknownDir, unknown).ok).toBe(false);
  });

  test('rejects name != frontmatter.name and XML tags + missing frontmatter', () => {
    expect(
      validateSkillForInstall(makeSkill('a', 'b', 'name: other\ndescription: d'), 'a').ok,
    ).toBe(false);
    expect(
      validateSkillForInstall(makeSkill('b', 'x', 'name: b\ndescription: Use <folder> here.'), 'b')
        .ok,
    ).toBe(false);
    const noFm = join(root, '.ok', 'skills', 'nofm');
    mkdirSync(noFm, { recursive: true });
    writeFileSync(join(noFm, 'SKILL.md'), '# no frontmatter', 'utf-8');
    expect(validateSkillForInstall(noFm, 'nofm').ok).toBe(false);
  });

  test('an empty description is a non-blocking warning, not an error (PRD-7596)', () => {
    const dir = makeSkill('nodesc', '# x', 'name: nodesc\ndescription: ');
    const v = validateSkillForInstall(dir, 'nodesc');
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.includes('no `description`'))).toBe(true);
  });

  test('flags a scripts/ dir', () => {
    const dir = makeSkill('with-scripts', '# x');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi', 'utf-8');
    expect(validateSkillForInstall(dir, 'with-scripts').hasScripts).toBe(true);
  });
});

describe('projectSkill / reverseProjectSkill', () => {
  test('an in-place canonical already at a host destination is left intact', () => {
    const dir = join(root, '.claude', 'skills', 'in-place');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: in-place\ndescription: d\n---\n\n# Keep me\n');

    expect(projectSkill(dir, 'in-place', root, ['claude'])).toEqual(['claude']);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('# Keep me');
  });

  test('never writes through a host root that ALIASES the canonical root', () => {
    const agentsSkills = join(root, '.agents', 'skills');
    mkdirSync(agentsSkills, { recursive: true });
    const dir = join(agentsSkills, 'aliased');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: aliased\ndescription: d\n---\n\n# Keep me\n');

    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.cursor'), { recursive: true });
    symlinkSync('../.agents/skills', join(root, '.claude', 'skills'), 'dir');
    symlinkSync('../.agents/skills', join(root, '.cursor', 'skills'), 'dir');

    projectSkill(dir, 'aliased', root, ['claude', 'cursor', 'codex']);

    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('# Keep me');
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);

    const codexLink = join(root, '.codex', 'skills', 'aliased');
    expect(lstatSync(codexLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(codexLink, 'SKILL.md'), 'utf-8')).toContain('# Keep me');
  });

  test('copy mode materializes bytes even when the canonical is a symlink', () => {
    const realDir = join(root, 'elsewhere', 'aliased-src');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, 'SKILL.md'),
      '---\nname: aliased-src\ndescription: d\n---\n\n# Real bytes\n',
    );
    const canonical = join(root, '.agents', 'skills', 'aliased-src');
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    symlinkSync(realDir, canonical, 'dir');

    projectSkill(canonical, 'aliased-src', root, ['claude'], 'copy');

    const dest = join(root, '.claude', 'skills', 'aliased-src');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('# Real bytes');

    rmSync(realDir, { recursive: true, force: true });
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  test('installs a symlink into each editor host dir and reverse removes the link', () => {
    const dir = makeSkill('trip-log', '# Steps');
    const written = projectSkill(dir, 'trip-log', root, [
      'claude',
      'cursor',
      'codex',
      'pi',
      'claude-desktop',
    ]);
    expect(written.sort()).toEqual(['claude', 'codex', 'cursor', 'pi']);
    for (const host of ['.claude', '.cursor', '.codex', '.pi']) {
      const link = join(root, host, 'skills', 'trip-log');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(link, 'SKILL.md'))).toBe(true);
      expect(readlinkSync(link).startsWith('..')).toBe(true);
    }

    const removed = reverseProjectSkill('trip-log', root, ['claude', 'cursor', 'codex', 'pi']);
    expect(removed.sort()).toEqual(['claude', 'codex', 'cursor', 'pi']);
    expect(existsSync(join(root, '.claude', 'skills', 'trip-log'))).toBe(false);
    expect(existsSync(join(root, '.pi', 'skills', 'trip-log'))).toBe(false);
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  test('reverse removes a DANGLING projection symlink (source already gone) — B4', () => {
    const dir = makeSkill('orphan', '# Steps');
    projectSkill(dir, 'orphan', root, ['claude', 'cursor', 'codex']);
    rmSync(dir, { recursive: true, force: true });
    const link = join(root, '.claude', 'skills', 'orphan');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link)).toBe(false);

    const removed = reverseProjectSkill('orphan', root, ['claude', 'cursor', 'codex']);
    expect(removed.sort()).toEqual(['claude', 'codex', 'cursor']);
    for (const host of ['.claude', '.cursor', '.codex']) {
      expect(() => lstatSync(join(root, host, 'skills', 'orphan'))).toThrow();
    }
  });

  test('install is authoritative — replaces a legacy real-dir copy with a symlink', () => {
    const dir = makeSkill('s', '# v1');
    const dest = skillHostDir(root, 'claude', 's') as string;
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale.md'), 'leftover', 'utf-8');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);

    projectSkill(dir, 's', root, ['claude']);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dest, 'stale.md'))).toBe(false);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  test('skillHostDir returns null for claude-desktop', () => {
    expect(skillHostDir(root, 'claude-desktop', 'x')).toBeNull();
    expect(skillHostDir(root, 'claude', 'x')).toContain('/.claude/skills/x');
    expect(skillHostDir(root, 'pi', 'x')).toContain('/.pi/skills/x');
  });
});

describe('readSkillBundledFiles', () => {
  test('lists bundled files as text, excludes SKILL.md, sorts, nulls binary', () => {
    const dir = makeSkill('bundle', '# Body');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'reference'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.py'), 'print("hi")\n', 'utf-8');
    writeFileSync(join(dir, 'reference', 'notes.md'), '# Notes', 'utf-8');
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0x89, 0x00, 0x01, 0x02]));

    const files = readSkillBundledFiles(dir);
    expect(files.map((f) => f.path)).toEqual(['logo.bin', 'reference/notes.md', 'scripts/run.py']);
    expect(files.find((f) => f.path === 'scripts/run.py')?.text).toBe('print("hi")\n');
    expect(files.find((f) => f.path === 'reference/notes.md')?.text).toBe('# Notes');
    expect(files.find((f) => f.path === 'logo.bin')?.text).toBeNull();
  });

  test('absent skill dir returns empty', () => {
    expect(readSkillBundledFiles(join(root, 'nope'))).toEqual([]);
  });

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test.skipIf(isRoot)('a genuine IO error THROWS rather than masquerading as binary', () => {
    const dir = makeSkill('locked', '# Body');
    mkdirSync(join(dir, 'reference'), { recursive: true });
    const secret = join(dir, 'reference', 'secret.md');
    writeFileSync(secret, '# Secret', 'utf-8');
    chmodSync(secret, 0o000);
    try {
      expect(() => readSkillBundledFiles(dir)).toThrow();
    } finally {
      chmodSync(secret, 0o644);
    }
  });
});

describe('hostSkillsRootEscapes', () => {
  test('false for a missing host root (created inside the project) and a normal dir', () => {
    expect(hostSkillsRootEscapes(root, join(root, '.claude', 'skills'))).toBe(false);
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    expect(hostSkillsRootEscapes(root, join(root, '.claude', 'skills'))).toBe(false);
  });

  test('true when the host root is a symlink escaping the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ok-outside-'));
    try {
      mkdirSync(join(root, '.claude'), { recursive: true });
      symlinkSync(outside, join(root, '.claude', 'skills'));
      expect(hostSkillsRootEscapes(root, join(root, '.claude', 'skills'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('projectInPlaceSkill / removeInPlaceSkillCopies (in-place fan-out guards)', () => {
  function makeAt(rel: string, body: string): string {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${rel.split('/').pop()}\ndescription: Use when testing.\n---\n${body}`,
    );
    return dir;
  }
  const hashOf = (dir: string) => parseSkillDir(dir)?.contentHash ?? '';

  test('copies into absent editors; only the canonical host itself is never written', () => {
    const canonical = makeAt('.agents/skills/foo', '# Body');
    const r = projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      canonicalRootRel: '.agents/skills',
      name: 'foo',
      cwd: root,
      targets: ['claude', 'codex', 'opencode'],
    });
    expect(r.conflicted).toEqual([]);
    expect(r.hosts.sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(lstatSync(join(root, '.claude/skills/foo')).isDirectory()).toBe(true);
    expect(lstatSync(join(root, '.claude/skills/foo')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(root, '.codex/skills/foo')).isDirectory()).toBe(true);
    expect(lstatSync(join(root, '.opencode/skills/foo')).isDirectory()).toBe(true);
  });

  test('NEVER clobbers a differing real dir (fork) — surfaced as conflicted', () => {
    const canonical = makeAt('.claude/skills/foo', '# Canonical');
    makeAt('.cursor/skills/foo', '# A DIFFERENT skill');
    const r = projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      canonicalRootRel: '.claude/skills',
      name: 'foo',
      cwd: root,
      targets: ['cursor'],
    });
    expect(r.conflicted).toEqual(['cursor']);
    expect(r.hosts).toEqual([]);
    expect(readFileSync(join(root, '.cursor/skills/foo/SKILL.md'), 'utf-8')).toContain(
      '# A DIFFERENT skill',
    );
  });

  test("replaces a built-in's DRIFTED projection — it is stale, not a fork", () => {
    const canonical = makeAt('.agents/skills/open-knowledge', '# Current');
    makeAt('.cursor/skills/open-knowledge', '# An OLD release of the same skill');
    const r = projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      canonicalRootRel: '.agents/skills',
      name: 'open-knowledge',
      cwd: root,
      targets: ['cursor'],
    });
    expect(r.conflicted).toEqual([]);
    expect(r.hosts).toEqual(['cursor']);
    expect(readFileSync(join(root, '.cursor/skills/open-knowledge/SKILL.md'), 'utf-8')).toContain(
      '# Current',
    );
  });

  test('a drifted dir for an ORDINARY skill is still untouchable', () => {
    const canonical = makeAt('.agents/skills/open-knowledge-ish', '# Current');
    makeAt('.cursor/skills/open-knowledge-ish', '# MINE');
    const r = projectInPlaceSkill({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      canonicalRootRel: '.agents/skills',
      name: 'open-knowledge-ish',
      cwd: root,
      targets: ['cursor'],
    });
    expect(r.conflicted).toEqual(['cursor']);
    expect(
      readFileSync(join(root, '.cursor/skills/open-knowledge-ish/SKILL.md'), 'utf-8'),
    ).toContain('# MINE');
  });

  test("uninstall removes a built-in's drifted projection too", () => {
    const canonical = makeAt('.agents/skills/open-knowledge', '# Current');
    makeAt('.cursor/skills/open-knowledge', '# An OLD release');
    const removed = removeInPlaceSkillCopies({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      name: 'open-knowledge',
      cwd: root,
      targets: ['cursor'],
    });
    expect(removed).toEqual(['cursor']);
    expect(existsSync(join(root, '.cursor/skills/open-knowledge'))).toBe(false);
  });

  test('remove deletes only lossless occurrences; canonical + forks survive', () => {
    const canonical = makeAt('.claude/skills/foo', '# Canonical');
    const hash = hashOf(canonical);
    const copy = makeAt('.cursor/skills/foo', '# Canonical');
    writeFileSync(
      join(root, '.cursor/skills/foo/SKILL.md'),
      readFileSync(join(canonical, 'SKILL.md')),
    );
    const fork = makeAt('.codex/skills/foo', '# FORKED content');
    mkdirSync(join(root, '.opencode/skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.opencode/skills/foo'), 'dir');

    const removed = removeInPlaceSkillCopies({
      canonicalAbs: canonical,
      canonicalHash: hash,
      name: 'foo',
      cwd: root,
      targets: ['claude', 'cursor', 'codex', 'opencode'],
    });
    expect(removed.sort()).toEqual(['cursor', 'opencode']);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(fork)).toBe(true);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(root, '.opencode/skills/foo'))).toBe(false);
  });

  test('remove re-points a DANGLING sibling but leaves one aimed elsewhere alone', () => {
    const canonical = makeAt('.claude/skills/foo', '# Canonical');
    mkdirSync(join(root, '.cursor/skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.cursor/skills/foo'), 'dir');
    const unrelated = makeAt('vendor/other', '# Someone else');
    mkdirSync(join(root, '.codex/skills'), { recursive: true });
    symlinkSync(unrelated, join(root, '.codex/skills/foo'), 'dir');
    mkdirSync(join(root, '.opencode/skills'), { recursive: true });
    symlinkSync(join(root, 'gone'), join(root, '.opencode/skills/foo'), 'dir');

    const removed = removeInPlaceSkillCopies({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      name: 'foo',
      cwd: root,
      targets: ['cursor'],
    });

    expect(removed).toEqual(['cursor']);
    expect(realpathSync(join(root, '.opencode/skills/foo'))).toBe(realpathSync(canonical));
    expect(realpathSync(join(root, '.codex/skills/foo'))).toBe(realpathSync(unrelated));
  });

  test('relocate collapses a sibling chained through the leave-behind link', () => {
    const canonical = makeAt('.agents/skills/foo', '# Canonical');
    mkdirSync(join(root, '.cursor/skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.cursor/skills/foo'), 'dir');
    const unrelated = makeAt('vendor/other', '# Someone else');
    mkdirSync(join(root, '.codex/skills'), { recursive: true });
    symlinkSync(unrelated, join(root, '.codex/skills/foo'), 'dir');

    const realRoot = realpathSync(root);
    const moved = relocateInPlaceCanonical({
      canonicalAbs: canonical,
      canonicalHash: hashOf(canonical),
      name: 'foo',
      cwd: realRoot,
      newTarget: 'claude',
      leaveLinkBehind: true,
    });

    expect(moved.ok).toBe(true);
    const dest = join(realRoot, '.claude/skills/foo');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(canonical).isSymbolicLink()).toBe(true);

    const cursorLink = join(realRoot, '.cursor/skills/foo');
    expect(resolve(dirname(cursorLink), readlinkSync(cursorLink))).toBe(dest);

    expect(realpathSync(join(root, '.codex/skills/foo'))).toBe(realpathSync(unrelated));
  });
});
