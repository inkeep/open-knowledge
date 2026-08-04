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
    // OK's own shipped bundle opts in.
    expect(
      validateSkillForInstall(dir, 'open-knowledge-mine', { allowReservedName: true }).ok,
    ).toBe(true);
  });

  test('the exact LEGACY pack names stay installable; unknown pack-prefixed names stay rejected', () => {
    // Existing installs are never renamed, so every pre-rename install
    // keeps its reserved-prefix name indefinitely — add-to-host/repair for
    // those must keep working.
    const legacy = 'open-knowledge-pack-knowledge-base';
    const legacyDir = makeSkill(legacy, '# x', `name: ${legacy}\ndescription: d`);
    expect(validateSkillForInstall(legacyDir, legacy).ok).toBe(true);
    // Anything else under the prefix is still reserved.
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

  // The shape that destroyed a real skill: `.claude/skills` is a FOLDER symlink
  // to `.agents/skills`, which is where the canonical lives. Writing the claude
  // projection resolves onto the canonical itself — the rm deletes the real
  // bundle and the symlink replacing it points at its own path. Every later host
  // then re-destroys it, because once the canonical is a self-link `realpathSync`
  // throws and the per-destination `sameEntry` check can no longer see it.
  test('never writes through a host root that ALIASES the canonical root', () => {
    const agentsSkills = join(root, '.agents', 'skills');
    mkdirSync(agentsSkills, { recursive: true });
    const dir = join(agentsSkills, 'aliased');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: aliased\ndescription: d\n---\n\n# Keep me\n');

    // `.claude/skills` and `.cursor/skills` both alias the canonical root.
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.cursor'), { recursive: true });
    symlinkSync('../.agents/skills', join(root, '.claude', 'skills'), 'dir');
    symlinkSync('../.agents/skills', join(root, '.cursor', 'skills'), 'dir');

    projectSkill(dir, 'aliased', root, ['claude', 'cursor', 'codex']);

    // The canonical is still a real directory holding its real bytes.
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('# Keep me');
    // And it did not become self-referential.
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);

    // A NON-aliased host still gets its link.
    const codexLink = join(root, '.codex', 'skills', 'aliased');
    expect(lstatSync(codexLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(codexLink, 'SKILL.md'), 'utf-8')).toContain('# Keep me');
  });

  // The shape that dangled a real skill: the canonical is itself a SYMLINK,
  // because `source` was pointed at another location. cpSync defaults to
  // dereference:false, so a "copy" projection would write a link to that other
  // location — and the host then holds nothing of its own. A copy must stand
  // alone; that is the entire difference from link mode.
  test('copy mode materializes bytes even when the canonical is a symlink', () => {
    const realDir = join(root, 'elsewhere', 'aliased-src');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(
      join(realDir, 'SKILL.md'),
      '---\nname: aliased-src\ndescription: d\n---\n\n# Real bytes\n',
    );
    // The canonical path is a link to it — what `source` leaves behind.
    const canonical = join(root, '.agents', 'skills', 'aliased-src');
    mkdirSync(join(root, '.agents', 'skills'), { recursive: true });
    symlinkSync(realDir, canonical, 'dir');

    projectSkill(canonical, 'aliased-src', root, ['claude'], 'copy');

    const dest = join(root, '.claude', 'skills', 'aliased-src');
    // A real directory holding real bytes — NOT a link back to the source.
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('# Real bytes');

    // Deleting the original tree must not empty the copy.
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
    // claude-desktop has no skill surface → skipped.
    expect(written.sort()).toEqual(['claude', 'codex', 'cursor', 'pi']);
    for (const host of ['.claude', '.cursor', '.codex', '.pi']) {
      const link = join(root, host, 'skills', 'trip-log');
      // It's a symlink, not a copied dir, and it resolves to the source.
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(join(link, 'SKILL.md'))).toBe(true);
      // Source is inside the project → the link target is relative (portable).
      expect(readlinkSync(link).startsWith('..')).toBe(true);
    }

    const removed = reverseProjectSkill('trip-log', root, ['claude', 'cursor', 'codex', 'pi']);
    expect(removed.sort()).toEqual(['claude', 'codex', 'cursor', 'pi']);
    expect(existsSync(join(root, '.claude', 'skills', 'trip-log'))).toBe(false);
    expect(existsSync(join(root, '.pi', 'skills', 'trip-log'))).toBe(false);
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

describe('projectInPlaceSkill / removeInPlaceSkillCopies (in-place fan-out guards)', () => {
  /** Author a real skill bundle at any root-relative dir. */
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
    // Every checked editor gets a real copy in its own dir — the vendor
    // capability table is deleted; writes are only skipped for the canonical
    // host itself and for aliased roots (observable facts).
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

  test('remove deletes only lossless occurrences; canonical + forks survive', () => {
    const canonical = makeAt('.claude/skills/foo', '# Canonical');
    const hash = hashOf(canonical);
    // Same-hash copy (lossless) + a fork (must survive) + an old symlink projection.
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
    expect(existsSync(canonical)).toBe(true); // NEVER the canonical
    expect(existsSync(fork)).toBe(true); // NEVER a differing dir
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(root, '.opencode/skills/foo'))).toBe(false);
  });

  // The re-point sweep after a removal walks EVERY host, not just `targets`,
  // so it decides the fate of links it was never asked about. Dangling ones are
  // adopted back onto the canonical; ones still aimed at something real were
  // aimed there on purpose. Relocation claims a wider set, and this pins the
  // narrower one so sharing the loop between them cannot quietly widen it.
  test('remove re-points a DANGLING sibling but leaves one aimed elsewhere alone', () => {
    const canonical = makeAt('.claude/skills/foo', '# Canonical');
    // The occurrence actually being removed (a link, so removal is lossless).
    mkdirSync(join(root, '.cursor/skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.cursor/skills/foo'), 'dir');
    // A sibling deliberately aimed at an unrelated bundle, NOT in `targets`.
    const unrelated = makeAt('vendor/other', '# Someone else');
    mkdirSync(join(root, '.codex/skills'), { recursive: true });
    symlinkSync(unrelated, join(root, '.codex/skills/foo'), 'dir');
    // A sibling pointing at nothing, NOT in `targets`.
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

  // The symmetric half of the test above, and it has to use `leaveLinkBehind`
  // to bite at all. Without it relocation RENAMES the old source away, so a
  // sibling aimed there simply dangles and the unconditional dangling rule
  // already claims it — `alsoClaim` changes nothing and a test written that way
  // passes with `alsoClaim: []`. The claim only does work when the old source
  // still RESOLVES: the leave-behind link makes the sibling chain through it to
  // `dest`, which is live, so only `alsoClaim` collapses that chain.
  //
  // Asserted on the link's DIRECT target, since `realpathSync` follows the chain
  // and reports the same answer either way.
  test('relocate collapses a sibling chained through the leave-behind link', () => {
    const canonical = makeAt('.agents/skills/foo', '# Canonical');
    // Aimed at the old source, which survives as a link to `dest`.
    mkdirSync(join(root, '.cursor/skills'), { recursive: true });
    symlinkSync(canonical, join(root, '.cursor/skills/foo'), 'dir');
    // Aimed at an unrelated bundle: nobody asked about it, leave it be.
    const unrelated = makeAt('vendor/other', '# Someone else');
    mkdirSync(join(root, '.codex/skills'), { recursive: true });
    symlinkSync(unrelated, join(root, '.codex/skills/foo'), 'dir');

    // `cwd` must be the REAL root. `mkdtemp` hands back `/var/...` on macOS while
    // the primitive realpaths its canonical to `/private/var/...`, and the claim
    // set compares those two spellings of one path — so under a raw tmpdir root
    // the chain claim silently never matches and this test cannot see it.
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
    // The swap: the old source is now a link standing in for the moved folder.
    expect(lstatSync(canonical).isSymbolicLink()).toBe(true);

    // The claim under test: re-pointed DIRECTLY at dest, not left chained
    // through the old source. Zero `alsoClaim` and this reads as `canonical`.
    const cursorLink = join(realRoot, '.cursor/skills/foo');
    expect(resolve(dirname(cursorLink), readlinkSync(cursorLink))).toBe(dest);

    // Aimed elsewhere on purpose: untouched, so the claim did not widen.
    expect(realpathSync(join(root, '.codex/skills/foo'))).toBe(realpathSync(unrelated));
  });
});
