import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostSkillsRootEscapes,
  projectSkill,
  readSkillBundledFiles,
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
    // OK's own shipped bundle opts in.
    expect(
      validateSkillForInstall(dir, 'open-knowledge-mine', { allowReservedName: true }).ok,
    ).toBe(true);
  });

  test('allows open-knowledge-pack-* (shipped pack skills) to reinstall', () => {
    const name = 'open-knowledge-pack-knowledge-base';
    const dir = makeSkill(name, '# x', `name: ${name}\ndescription: d`);
    // Pack skills sit under the reserved prefix but are OK's own shipped content,
    // so a user-triggered (re)install must not be blocked by the reserved guard.
    expect(validateSkillForInstall(dir, name).ok).toBe(true);
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

  test('flags a scripts/ dir', () => {
    const dir = makeSkill('with-scripts', '# x');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'run.sh'), 'echo hi', 'utf-8');
    expect(validateSkillForInstall(dir, 'with-scripts').hasScripts).toBe(true);
  });
});

describe('projectSkill / reverseProjectSkill', () => {
  test('installs a symlink into each editor host dir and reverse removes the link', () => {
    const dir = makeSkill('trip-log', '# Steps');
    const written = projectSkill(dir, 'trip-log', root, [
      'claude',
      'cursor',
      'codex',
      'claude-desktop',
    ]);
    // claude-desktop has no skill surface → skipped.
    expect(written.sort()).toEqual(['claude', 'codex', 'cursor']);
    for (const host of ['.claude', '.cursor', '.codex']) {
      const link = join(root, host, 'skills', 'trip-log');
      // It's a symlink, not a copied dir, and it resolves to the source.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(link, 'SKILL.md'))).toBe(true);
      // Source is inside the project → the link target is relative (portable).
      expect(readlinkSync(link).startsWith('..')).toBe(true);
    }

    const removed = reverseProjectSkill('trip-log', root, ['claude', 'cursor', 'codex']);
    expect(removed.sort()).toEqual(['claude', 'codex', 'cursor']);
    expect(existsSync(join(root, '.claude', 'skills', 'trip-log'))).toBe(false);
    // Uninstall removes only the link — the source is untouched.
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  test('reverse removes a DANGLING projection symlink (source already gone) — B4', () => {
    // Reproduce the cross-scope-move residue: project, then delete the SOURCE so
    // the host-dir symlinks dangle. `existsSync` follows the link → false, so the
    // pre-fix `reverseProjectSkill` skipped them and left orphans (the registry
    // "duplicate"). The lstat-based check must still remove them.
    const dir = makeSkill('orphan', '# Steps');
    projectSkill(dir, 'orphan', root, ['claude', 'cursor', 'codex']);
    rmSync(dir, { recursive: true, force: true }); // links now dangle
    const link = join(root, '.claude', 'skills', 'orphan');
    expect(lstatSync(link).isSymbolicLink()).toBe(true); // still on disk
    expect(existsSync(link)).toBe(false); // ...but follows to a missing target

    const removed = reverseProjectSkill('orphan', root, ['claude', 'cursor', 'codex']);
    expect(removed.sort()).toEqual(['claude', 'codex', 'cursor']);
    for (const host of ['.claude', '.cursor', '.codex']) {
      // The dangling link is gone — lstat throws now (no entry at all).
      expect(() => lstatSync(join(root, host, 'skills', 'orphan'))).toThrow();
    }
  });

  test('install is authoritative — replaces a legacy real-dir copy with a symlink', () => {
    const dir = makeSkill('s', '# v1');
    const dest = skillHostDir(root, 'claude', 's') as string;
    // Simulate a legacy copy-install: a real directory at the host path.
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale.md'), 'leftover', 'utf-8');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);

    projectSkill(dir, 's', root, ['claude']);
    // Now a symlink to the source; the stale real-dir contents are gone.
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dest, 'stale.md'))).toBe(false);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  test('skillHostDir returns null for claude-desktop', () => {
    expect(skillHostDir(root, 'claude-desktop', 'x')).toBeNull();
    expect(skillHostDir(root, 'claude', 'x')).toContain('/.claude/skills/x');
  });
});

describe('readSkillBundledFiles', () => {
  test('lists bundled files as text, excludes SKILL.md, sorts, nulls binary', () => {
    const dir = makeSkill('bundle', '# Body');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'reference'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.py'), 'print("hi")\n', 'utf-8');
    writeFileSync(join(dir, 'reference', 'notes.md'), '# Notes', 'utf-8');
    // A binary file (contains a NUL byte) → text is null, never executed/served.
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0x89, 0x00, 0x01, 0x02]));

    const files = readSkillBundledFiles(dir);
    // SKILL.md is excluded; the rest are sorted by POSIX path.
    expect(files.map((f) => f.path)).toEqual(['logo.bin', 'reference/notes.md', 'scripts/run.py']);
    expect(files.find((f) => f.path === 'scripts/run.py')?.text).toBe('print("hi")\n');
    expect(files.find((f) => f.path === 'reference/notes.md')?.text).toBe('# Notes');
    expect(files.find((f) => f.path === 'logo.bin')?.text).toBeNull();
  });

  test('absent skill dir returns empty', () => {
    expect(readSkillBundledFiles(join(root, 'nope'))).toEqual([]);
  });

  // Root bypasses file permissions, so chmod 000 wouldn't deny the read there.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test.skipIf(isRoot)('a genuine IO error THROWS rather than masquerading as binary', () => {
    // A read error must NOT surface as `text: null`: the cross-scope move skips
    // null-text files as "binary" and then deletes the source, so a swallowed
    // read error would be silent data loss. It must throw so the move aborts.
    const dir = makeSkill('locked', '# Body');
    mkdirSync(join(dir, 'reference'), { recursive: true });
    const secret = join(dir, 'reference', 'secret.md');
    writeFileSync(secret, '# Secret', 'utf-8');
    chmodSync(secret, 0o000);
    try {
      expect(() => readSkillBundledFiles(dir)).toThrow();
    } finally {
      chmodSync(secret, 0o644); // restore so afterEach can clean up
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
