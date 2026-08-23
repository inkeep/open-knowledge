import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import {
  removableSkillOccurrenceDirs,
  resolveDefaultSkillHomeRel,
  resolveGlobalNativeSkillDir,
  scanGlobalInPlaceSkills,
  scanHostRootAliases,
  scanInPlaceSkillDirs,
  scanInPlaceSkills,
} from './in-place-skills.ts';

describe('resolveDefaultSkillHomeRel', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ok-default-skill-home-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test.each([
    'project',
    'global',
  ] as const)('returns no %s home and creates nothing when no host root exists', (scope) => {
    expect(resolveDefaultSkillHomeRel(base, scope)).toBeNull();
    expect(existsSync(join(base, '.claude'))).toBe(false);
    expect(existsSync(join(base, '.agents'))).toBe(false);
  });

  test('keeps existing hub and concrete roots selectable by precedence', () => {
    mkdirSync(join(base, '.codex'), { recursive: true });
    mkdirSync(join(base, '.claude'), { recursive: true });
    expect(resolveDefaultSkillHomeRel(base, 'project')).toBe('.claude/skills');

    mkdirSync(join(base, '.agents'), { recursive: true });
    expect(resolveDefaultSkillHomeRel(base, 'project')).toBe('.agents/skills');
    expect(resolveDefaultSkillHomeRel(base, 'global')).toBe('.agents/skills');
  });

  test('does not claim `.github` as a project home on its mere presence', () => {
    mkdirSync(join(base, '.github', 'workflows'), { recursive: true });
    expect(resolveDefaultSkillHomeRel(base, 'project')).toBeNull();
  });

  test('claims `.github/skills` once the project actually adopted it', () => {
    mkdirSync(join(base, '.github', 'skills'), { recursive: true });
    expect(resolveDefaultSkillHomeRel(base, 'project')).toBe('.github/skills');
  });

  test('claims the user-global Copilot home from its own dotdir', () => {
    mkdirSync(join(base, '.copilot'), { recursive: true });
    expect(resolveDefaultSkillHomeRel(base, 'global')).toBe('.copilot/skills');
  });
});

function writeSkill(root: string, rel: string, body: string): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${rel.split('/').pop()}\ndescription: d\n---\n\n${body}\n`,
  );
}

describe('scanInPlaceSkillDirs', () => {
  let contentDir: string;
  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-'));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('admits a skill living in an editor dir; ignores non-skill entries', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# Foo');
    mkdirSync(join(contentDir, '.claude/plugins/p'), { recursive: true }); // not a skill
    writeFileSync(join(contentDir, '.claude/skills/loose.txt'), 'x'); // file, not a bundle dir

    const dirs = scanInPlaceSkillDirs(contentDir);
    expect([...dirs]).toEqual(['.claude/skills/foo']);

    // The set drives content-filter admission end to end.
    const filter = createContentFilter({
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: dirs,
    });
    expect(filter.isExcluded('.claude/skills/foo/SKILL.md')).toBe(false);
    expect(filter.isExcluded('.claude/plugins/p/x.md')).toBe(true);
  });

  test('same skill in two editors (identical bytes) dedups to the precedence winner', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# Same');
    writeSkill(contentDir, '.codex/skills/foo', '# Same');
    const dirs = scanInPlaceSkillDirs(contentDir);
    // claude wins precedence; codex copy excluded.
    expect([...dirs]).toEqual(['.claude/skills/foo']);
  });

  test('same name, DIFFERENT bytes: BOTH admitted as content', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# Claude version');
    writeSkill(contentDir, '.codex/skills/foo', '# Codex version DIFFERENT');
    const dirs = scanInPlaceSkillDirs(contentDir);
    expect([...dirs].sort()).toEqual(['.claude/skills/foo', '.codex/skills/foo']);

    // Both are real, editable content — neither is hidden behind the other.
    const filter = createContentFilter({
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: dirs,
    });
    expect(filter.isExcluded('.claude/skills/foo/SKILL.md')).toBe(false);
    expect(filter.isExcluded('.codex/skills/foo/SKILL.md')).toBe(false);
  });

  test('empty content dir yields an empty admit-set', () => {
    expect([...scanInPlaceSkillDirs(contentDir)]).toEqual([]);
  });
});

describe('scanInPlaceSkills (list projection)', () => {
  let contentDir: string;
  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-'));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('one entry per canonical with real dir, description, and all same-hash hosts', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# Same');
    writeSkill(contentDir, '.codex/skills/foo', '# Same');
    writeSkill(contentDir, '.cursor/skills/bar', '# Bar');

    const skills = scanInPlaceSkills(contentDir);
    expect(skills.map((s) => s.name).sort()).toEqual(['bar', 'foo']);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.claude/skills/foo');
    expect(foo?.hosts).toEqual(['claude', 'codex']);
    expect(foo?.description).toBe('d');
    expect(foo?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const bar = skills.find((s) => s.name === 'bar');
    expect(bar?.dir).toBe('.cursor/skills/bar');
    expect(bar?.hosts).toEqual(['cursor']);
  });

  test('same name, different bytes: two rows that point at each other', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# A');
    writeSkill(contentDir, '.codex/skills/foo', '# B different');
    const skills = scanInPlaceSkills(contentDir);
    expect(skills).toHaveLength(2);

    const fromClaude = skills.find((s) => s.dir === '.claude/skills/foo');
    const fromCodex = skills.find((s) => s.dir === '.codex/skills/foo');
    // Each row owns only its own physical occurrence...
    expect(fromClaude?.hosts).toEqual(['claude']);
    expect(fromCodex?.hosts).toEqual(['codex']);
    // ...and names the other's slot as occupied by someone else. Symmetric:
    // neither side is the "loser" whose folder the other one hides.
    expect(fromClaude?.conflictHosts).toEqual(['codex']);
    expect(fromCodex?.conflictHosts).toEqual(['claude']);
  });

  test('the by-name default sorts first among same-name rows', () => {
    // Every by-name caller resolves with `.find(s => s.name === n)`, so the row
    // a host-less lookup should land on has to come first or those callers
    // silently resolve in content-hash order.
    writeSkill(contentDir, '.codex/skills/foo', '# zzz sorts late by hash');
    writeSkill(contentDir, '.claude/skills/foo', '# aaa');
    const skills = scanInPlaceSkills(contentDir);
    expect(skills.find((s) => s.name === 'foo')?.dir).toBe('.claude/skills/foo');
  });

  test("OK's own bundles collapse to one row even when a projection drifted", () => {
    // A divergence is the user's only when they hand-edited a copy. Built-ins
    // are read-only and OK ships their bytes, so a drifted projection (a stale
    // pre-split copy, say) is an artifact to ignore, not a second skill.
    writeSkill(contentDir, '.claude/skills/open-knowledge', '# current');
    writeSkill(contentDir, '.agents/skills/open-knowledge', '# stale pre-split copy');
    // An authored skill in the same tree still gets its two rows.
    writeSkill(contentDir, '.claude/skills/mine', '# A');
    writeSkill(contentDir, '.agents/skills/mine', '# B different');

    const skills = scanInPlaceSkills(contentDir);
    expect(skills.filter((s) => s.name === 'open-knowledge')).toHaveLength(1);
    expect(skills.filter((s) => s.name === 'mine')).toHaveLength(2);
    // The one built-in row is the by-name default, not whichever hash sorted first.
    expect(skills.find((s) => s.name === 'open-knowledge')?.dir).toBe(
      '.agents/skills/open-knowledge',
    );
    // And it must not carry conflict hosts — the drifted copy is an artifact to
    // ignore, not a conflict to badge.
    expect(skills.find((s) => s.name === 'open-knowledge')?.conflictHosts).toEqual([]);
  });

  test('three distinct contents under one name yield three rows', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# A');
    writeSkill(contentDir, '.codex/skills/foo', '# B different');
    writeSkill(contentDir, '.cursor/skills/foo', '# C different again');
    const skills = scanInPlaceSkills(contentDir);
    expect(skills).toHaveLength(3);
    // N-way falls out of the model: every row lists the other two.
    for (const s of skills) {
      expect(s.hosts).toHaveLength(1);
      expect([...s.conflictHosts].sort()).toEqual(
        ['claude', 'codex', 'cursor'].filter((h) => h !== s.hosts[0]),
      );
    }
  });

  test('a same-named sibling still dedups its OWN copies', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# A');
    writeSkill(contentDir, '.cursor/skills/foo', '# A'); // copy of the claude one
    writeSkill(contentDir, '.codex/skills/foo', '# B different');
    const skills = scanInPlaceSkills(contentDir);
    expect(skills).toHaveLength(2);
    const a = skills.find((s) => s.dir === '.claude/skills/foo');
    expect(a?.hosts).toEqual(['claude', 'cursor']); // one skill, two locations
    expect(a?.conflictHosts).toEqual(['codex']);
  });

  test('size reports the three tiers from the on-disk bundle, excluding non-readable files', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# Foo body content');
    // A readable reference contributes to on-demand; a script never does — the
    // producer feeds the estimator the real tree, which filters by extension.
    mkdirSync(join(contentDir, '.claude/skills/foo/references'), { recursive: true });
    writeFileSync(join(contentDir, '.claude/skills/foo/references/ref.md'), 'x'.repeat(400));
    mkdirSync(join(contentDir, '.claude/skills/foo/scripts'), { recursive: true });
    writeFileSync(join(contentDir, '.claude/skills/foo/scripts/run.sh'), 'y'.repeat(400));

    const foo = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');
    // name ("foo"=3) + description ("d"=1) = 4 chars / 4.
    expect(foo?.size.alwaysOn).toBe(1);
    expect(foo?.size.onTrigger).toBeGreaterThan(0);
    // 400-char readable .md → 100 tokens; the equal-length .sh contributes zero.
    expect(foo?.size.onDemand).toBe(100);
  });

  test('a bundle with no references reports zero on-demand', () => {
    writeSkill(contentDir, '.claude/skills/bare', '# just a body');
    const bare = scanInPlaceSkills(contentDir).find((s) => s.name === 'bare');
    expect(bare?.size.onDemand).toBe(0);
  });

  test('a symlinked bundle dir is followed for size (corpus is symlinks into a shared dir)', () => {
    const shared = join(contentDir, 'shared-store', 'foo');
    mkdirSync(shared, { recursive: true });
    writeFileSync(
      join(shared, 'SKILL.md'),
      `---\nname: foo\ndescription: d\n---\n\n${'z'.repeat(80)}\n`,
    );
    mkdirSync(join(contentDir, '.claude/skills'), { recursive: true });
    symlinkSync(shared, join(contentDir, '.claude/skills/foo'), 'dir');

    const foo = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.claude/skills/foo');
    // The body lives only behind the symlink; a non-zero on-trigger proves the
    // walk read through it.
    expect(foo?.size.onTrigger).toBeGreaterThan(0);
  });

  test('.agents/skills is a first-class host and wins precedence among same-hash copies (R14)', () => {
    writeSkill(contentDir, '.agents/skills/foo', '# Same');
    writeSkill(contentDir, '.claude/skills/foo', '# Same');
    writeSkill(contentDir, '.agents/skills/solo', '# Only in agents');

    const skills = scanInPlaceSkills(contentDir);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.agents/skills/foo');
    expect(foo?.hosts).toEqual(['agents', 'claude']);
    const solo = skills.find((s) => s.name === 'solo');
    expect(solo?.dir).toBe('.agents/skills/solo');
    // Observable facts only: no vendor-capability hosts (table deleted).
    expect(solo?.hosts).toEqual(['agents']);
  });
});

describe('parse cache (bundle stamp invalidation)', () => {
  let contentDir: string;
  // A pinned mtime so the stamp is controlled explicitly rather than left to
  // depend on filesystem clock resolution between successive writes.
  const PINNED = new Date(1_700_000_000_000);
  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-parse-cache-'));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  const skillMdOf = (name: string) => join(contentDir, `.claude/skills/${name}/SKILL.md`);

  test('serves an unchanged bundle from cache: a stamp-preserving edit is not re-read', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# body one');
    utimesSync(skillMdOf('foo'), PINNED, PINNED);
    const first = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');

    // Swap the body for different bytes of the SAME length and restore the pinned
    // mtime: relpath+size+mtime are unchanged, so the stamp matches. A re-parse
    // would surface the new hash; the cache returns the old one.
    const swapped = readFileSync(skillMdOf('foo'), 'utf8').replace('# body one', '# body two');
    writeFileSync(skillMdOf('foo'), swapped);
    utimesSync(skillMdOf('foo'), PINNED, PINNED);

    const second = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');
    expect(second?.contentHash).toBe(first?.contentHash);
  });

  test('a file-size change invalidates the cache and moves the reported size', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# short');
    const first = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');

    // A real on-disk edit that grows the body must surface on the next list, not a
    // permanently cached figure.
    writeFileSync(
      skillMdOf('foo'),
      `---\nname: foo\ndescription: d\n---\n\n${'word '.repeat(200)}\n`,
    );
    const second = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');
    expect(second?.contentHash).not.toBe(first?.contentHash);
    expect(second?.size.onTrigger).toBeGreaterThan(first?.size.onTrigger ?? 0);
  });

  test('an mtime-only change (identical size) invalidates the cache', () => {
    writeSkill(contentDir, '.claude/skills/foo', '# one');
    utimesSync(skillMdOf('foo'), PINNED, PINNED);
    const first = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');

    // Same-length body swap (size identical) with a bumped mtime: mtime is the ONLY
    // changed stamp field, so a re-parse here proves mtime alone invalidates.
    const swapped = readFileSync(skillMdOf('foo'), 'utf8').replace('# one', '# two');
    writeFileSync(skillMdOf('foo'), swapped);
    const later = new Date(PINNED.getTime() + 5000);
    utimesSync(skillMdOf('foo'), later, later);

    const second = scanInPlaceSkills(contentDir).find((s) => s.name === 'foo');
    expect(second?.contentHash).not.toBe(first?.contentHash);
  });
});

describe('global tier (R12): scanGlobalInPlaceSkills + resolveGlobalNativeSkillDir', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-inplace-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('scans user editor dirs (incl. the non-standard pi layout + ~/.agents hub)', () => {
    writeSkill(home, '.claude/skills/foo', '# Same');
    writeSkill(home, '.codex/skills/foo', '# Same'); // copy → deduped
    writeSkill(home, '.pi/agent/skills/nested', '# Pi layout');
    writeSkill(home, '.agents/skills/hub', '# Hub');

    const skills = scanGlobalInPlaceSkills(home);
    expect(skills.map((s) => s.name).sort()).toEqual(['foo', 'hub', 'nested']);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.claude/skills/foo');
    expect(foo?.hosts).toEqual(['claude', 'codex']);
    expect(skills.every((s) => s.contentHash.length === 64)).toBe(true);
  });

  test('probe resolves the precedence-winning native dir; null when absent', () => {
    writeSkill(home, '.codex/skills/foo', '# A');
    writeSkill(home, '.claude/skills/foo', '# A');
    // claude beats codex; agents beats both.
    expect(resolveGlobalNativeSkillDir(home, 'foo')).toBe(join(home, '.claude/skills/foo'));
    writeSkill(home, '.agents/skills/foo', '# A');
    expect(resolveGlobalNativeSkillDir(home, 'foo')).toBe(join(home, '.agents/skills/foo'));
    expect(resolveGlobalNativeSkillDir(home, 'missing')).toBeNull();
  });
});

describe('symlinked occurrences (D7 disclosure)', () => {
  let contentDir: string;
  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-inplace-link-'));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('a DIR-LEVEL root symlink (sync-tool style) discloses as VIA, not a copy', () => {
    writeSkill(contentDir, '.agents/skills/foo', '# Same');
    // The WHOLE .codex/skills root is a symlink to .agents/skills — the leaf
    // path reads as a real dir but is the same inode as the source.
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    symlinkSync(join(contentDir, '.agents/skills'), join(contentDir, '.codex/skills'), 'dir');

    const skills = scanInPlaceSkills(contentDir);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.agents/skills/foo');
    expect(foo?.hosts).not.toContain('codex'); // an alias (via scanHostRootAliases), not a host
    expect(foo?.copyDirs).toEqual([]); // NOT a copy — same physical folder
  });

  test('a user symlink counts as a host AND is reported in linkedHosts', () => {
    writeSkill(contentDir, '.agents/skills/foo', '# Same');
    mkdirSync(join(contentDir, '.codex/skills'), { recursive: true });
    symlinkSync(
      join(contentDir, '.agents/skills/foo'),
      join(contentDir, '.codex/skills/foo'),
      'dir',
    );

    const skills = scanInPlaceSkills(contentDir);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.agents/skills/foo');
    expect(foo?.hosts).toEqual(['agents', 'codex']);
    expect(foo?.linkedHosts).toEqual(['codex']);
    // The symlink itself is never a canonical admission target.
    expect([...scanInPlaceSkillDirs(contentDir)]).toEqual(['.agents/skills/foo']);
  });
});

describe('scanHostRootAliases (folder-level aliases, observable facts only)', () => {
  let contentDir: string;
  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-root-alias-'));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('a skills root symlinked to another root maps host -> target rel', () => {
    mkdirSync(join(contentDir, '.agents/skills'), { recursive: true });
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    symlinkSync(join(contentDir, '.agents/skills'), join(contentDir, '.codex/skills'), 'dir');
    expect(scanHostRootAliases(contentDir, 'project')).toEqual({ codex: '.agents/skills' });
  });

  test('real, absent, and outside-base roots are not aliases', () => {
    mkdirSync(join(contentDir, '.claude/skills'), { recursive: true }); // real
    const outside = mkdtempSync(join(tmpdir(), 'ok-outside-'));
    mkdirSync(join(contentDir, '.cursor'), { recursive: true });
    symlinkSync(outside, join(contentDir, '.cursor/skills'), 'dir'); // escapes base
    try {
      expect(scanHostRootAliases(contentDir, 'project')).toEqual({});
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a sticky source pref can NEVER elect an alias-rooted occurrence', () => {
    // The 2026-07-23 orphan-source bug: `sources: {foo: codex}` while
    // .codex/skills is a symlink to .agents/skills elected the ALIAS path as
    // canonical — rendering an orphan folder row for a location that is a view.
    writeSkill(contentDir, '.agents/skills/foo', '# Same');
    mkdirSync(join(contentDir, '.codex'), { recursive: true });
    symlinkSync(join(contentDir, '.agents/skills'), join(contentDir, '.codex/skills'), 'dir');
    mkdirSync(join(contentDir, '.ok/local'), { recursive: true });
    writeFileSync(
      join(contentDir, '.ok/local/skill-placements.json'),
      JSON.stringify({ skills: {}, sources: { foo: 'codex' } }),
    );
    const skills = scanInPlaceSkills(contentDir);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.agents/skills/foo');
    expect(foo?.hosts).toEqual(['agents']);
  });

  test('a PARENT-dir symlink (whole .codex -> .agents) is detected too', () => {
    mkdirSync(join(contentDir, '.agents/skills'), { recursive: true });
    symlinkSync(join(contentDir, '.agents'), join(contentDir, '.codex'), 'dir');
    expect(scanHostRootAliases(contentDir, 'project')).toEqual({ codex: '.agents/skills' });
  });

  test('a CUSTOM root symlinked into another root is an alias too (keyed by its path)', () => {
    // `.tim/skills → .ok/skills`: the ledger-known custom root is a view of
    // the target — alias-mapped (no row, audience icon rides the target) and
    // its occurrences never win election.
    writeSkill(contentDir, '.ok/skills/foo', '# Same');
    mkdirSync(join(contentDir, '.tim'), { recursive: true });
    symlinkSync(join(contentDir, '.ok/skills'), join(contentDir, '.tim/skills'), 'dir');
    mkdirSync(join(contentDir, '.ok/local'), { recursive: true });
    writeFileSync(
      join(contentDir, '.ok/local/skill-placements.json'),
      JSON.stringify({
        // Both roots ledger-known, as promotion records them in reality.
        skills: {
          foo: [
            { path: '.ok/skills/foo', mode: 'copy' },
            { path: '.tim/skills/foo', mode: 'copy' },
          ],
        },
        sources: {},
      }),
    );
    expect(scanHostRootAliases(contentDir, 'project')).toEqual({
      '.tim/skills': '.ok/skills',
    });
    // Election: the custom-root source stays canonical; the alias path never
    // surfaces as an independent host.
    const skills = scanInPlaceSkills(contentDir);
    const foo = skills.find((s) => s.name === 'foo');
    expect(foo?.dir).toBe('.ok/skills/foo');
    expect(foo?.hosts).not.toContain('.tim/skills');
  });
});

describe('removableSkillOccurrenceDirs', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'ok-occurrences-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const hashOf = (rel: string) => parseSkillDir(join(base, rel))?.contentHash as string;

  test('removes THIS skill everywhere, and never a same-named fork', () => {
    // The blocker this guards: the registry models two same-named bundles with
    // different bytes as two DISTINCT skills (`conflictHosts`). Deleting
    // `.cursor/skills/foo` because `.claude/skills/foo` moved away destroys a
    // bundle its owner never touched — unrecoverably when it is untracked.
    writeSkill(base, '.claude/skills/foo', '# Moved');
    writeSkill(base, '.agents/skills/foo', '# Moved');
    writeSkill(base, '.cursor/skills/foo', '# A DIFFERENT skill that happens to share the name');
    const moved = hashOf('.claude/skills/foo');

    const dirs = removableSkillOccurrenceDirs(base, 'project', 'foo', moved);

    expect(new Set(dirs)).toEqual(
      new Set([join(base, '.claude/skills/foo'), join(base, '.agents/skills/foo')]),
    );
    expect(dirs).not.toContain(join(base, '.cursor/skills/foo'));
  });

  test('a symlink goes even when its target is already gone', () => {
    // A projection whose target the move deleted is still a dir entry the next
    // scan trips on, and `existsSync` reports it absent — hence lstat.
    mkdirSync(join(base, '.claude/skills'), { recursive: true });
    symlinkSync(join(base, 'gone'), join(base, '.claude/skills/foo'));
    expect(removableSkillOccurrenceDirs(base, 'project', 'foo', 'any-hash')).toEqual([
      join(base, '.claude/skills/foo'),
    ]);
  });

  test('covers the legacy .ok/skills store, not just host roots', () => {
    // A copy parked outside the standard roots would otherwise survive the move
    // and be re-detected as a second skill at the scope just moved away from.
    writeSkill(base, '.ok/skills/foo', '# Moved');
    const moved = hashOf('.ok/skills/foo');
    expect(removableSkillOccurrenceDirs(base, 'project', 'foo', moved)).toEqual([
      join(base, '.ok/skills/foo'),
    ]);
  });

  test('nothing to remove is an empty list', () => {
    expect(removableSkillOccurrenceDirs(base, 'project', 'nothing-here', 'h')).toEqual([]);
  });
});
