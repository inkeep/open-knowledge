import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENKNOWLEDGE_SKILLS_REPO } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { readInstalledSkills } from '../installed-skills-marker.ts';
import {
  classifyPresentPackSkill,
  installPackSkill,
  resolvePackSkillSources,
} from './install-pack-skill.ts';

/** Simulate `ok init` having installed the platform skill for an editor dir. */
function setUpEditor(proj: string, editorDir: string): void {
  const platformDir = join(proj, editorDir, 'skills', 'open-knowledge');
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, 'SKILL.md'), '# platform\n');
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ok-seed-skill-'));
}

/**
 * The pack's orientation-skill name AS RESOLVED ON THIS MACHINE. Names are
 * frontmatter-driven and `resolvePackSkillSources` probes a co-installed OK
 * Desktop bundle before the repo assets, so a hardcoded name would pin the test
 * to whichever bundle this machine happens to carry.
 */
function orientationName(packId: string): string {
  const [first] = resolvePackSkillSources(packId);
  expect(first).toBeDefined();
  return (first as { name: string }).name;
}

describe('installPackSkill', () => {
  test('authors the pack skill IN PLACE at the default home (store retirement)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    const result = await installPackSkill(proj, 'knowledge-base');
    expect(result.editors).toEqual(['Claude Code']);
    expect(result.conflicts).toEqual([]);
    // The source lands at the project's default skill home (here `.claude/
    // skills` — the first existing editor root), NOT the retired `.ok/skills`
    // store. The scan is the host-set truth; no install marker is written.
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    expect(readInstalledSkills(proj).skills[name]).toBeUndefined();
  });

  test('records skills.sh provenance in .ok/skills-lock.json for reimport', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    await installPackSkill(proj, 'knowledge-base');
    // Provenance makes a seeded pack update through the SAME reimport path as any
    // imported skill: deterministic source (the open-knowledge-skills projection),
    // the skill selector is the skill's own name, plus its content hash.
    const lock = JSON.parse(readFileSync(join(proj, '.ok', 'skills-lock.json'), 'utf-8')) as {
      skills: Record<string, { source: string; skill: string; contentHash: string }>;
    };
    const entry = lock.skills[name];
    expect(entry).toBeDefined();
    expect(entry.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
    expect(entry.skill).toBe(name);
    expect(entry.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('installs for every set-up editor (claude + cursor + codex)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    setUpEditor(proj, '.cursor');
    setUpEditor(proj, '.codex');
    const name = orientationName('entity-vault');
    expect((await installPackSkill(proj, 'entity-vault')).editors.sort()).toEqual([
      'Claude Code',
      'Codex',
      'Cursor',
    ]);
    // Source at the default home; real copies fanned to the other editors.
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.cursor', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.codex', 'skills', name, 'SKILL.md'))).toBe(true);
  });

  test('installs the codebase-wiki pack skill from the source assets', async () => {
    // Confirms the new pack's SKILL.md asset resolves through the bundled-skill
    // probe (source `assets/skills/packs/codebase-wiki/` when no built dist).
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('codebase-wiki');
    expect((await installPackSkill(proj, 'codebase-wiki')).editors).toEqual(['Claude Code']);
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
  });

  test('a decomposed pack installs its root skill plus every member skill', async () => {
    // `software-lifecycle` ships an orientation SKILL.md at the pack root plus one
    // scenario skill per subdirectory. Each installs as its own top-level skill
    // (name == SKILL.md frontmatter, per the Agent Skills standard).
    //
    // Assert against `resolvePackSkillSources` rather than a hardcoded name list:
    // it probes a co-installed OK Desktop bundle first, so a machine with an older
    // desktop build resolves a different (possibly not-yet-decomposed) pack. The
    // invariant under test is "every resolved source installs, and members are not
    // nested inside the root skill" — not which sources this machine resolves.
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const sources = resolvePackSkillSources('software-lifecycle');
    expect(sources.length).toBeGreaterThan(0);
    expect((await installPackSkill(proj, 'software-lifecycle')).editors).toEqual(['Claude Code']);

    for (const { name } of sources) {
      expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    }
    // The root skill's copy carries no member subdirectory — that would ship each
    // scenario skill twice, once nested inside a skill that is not its own.
    const root = sources[0];
    expect(root).toBeDefined();
    for (const member of root?.excludePaths ?? []) {
      expect(existsSync(join(proj, '.claude', 'skills', root?.name ?? '', member))).toBe(false);
    }
  });

  test('no editor set up: skips skill materialization without creating a host root', async () => {
    const proj = tmpProject();
    const name = orientationName('knowledge-base');
    const result = await installPackSkill(proj, 'knowledge-base');

    expect(result).toEqual({ editors: [], conflicts: [] });
    expect(existsSync(join(proj, '.claude'))).toBe(false);
    expect(existsSync(join(proj, '.agents'))).toBe(false);
    expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    expect(readInstalledSkills(proj).skills[name]).toBeUndefined();
  });

  test('no-op for a pack that ships no skill', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const result = await installPackSkill(proj, 'no-such-pack');
    expect(result.editors).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  test('re-seed preserves a user-edited pack skill (no rm+cp clobber)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    // First install authors the shipped source.
    await installPackSkill(proj, 'knowledge-base');
    const sourcePath = join(proj, '.claude', 'skills', name, 'SKILL.md');
    expect(existsSync(sourcePath)).toBe(true);

    // The pack skill is now the user's fork — they edit it.
    const edited = `---\nname: ${name}\ndescription: my edit\n---\nmine\n`;
    writeFileSync(sourcePath, edited, 'utf-8');

    // Re-running seed (CLI / desktop IPC / HTTP all funnel here) must NOT reset
    // the source back to the shipped body — the lock's provenance says the fork
    // is ours, so it is neither clobbered nor reported as a conflict.
    const result = await installPackSkill(proj, 'knowledge-base');
    expect(result.editors).toEqual(['Claude Code']);
    expect(result.conflicts.map((c) => c.name)).not.toContain(name);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(edited);
  });

  test('a user-owned same-named skill is a reported conflict, never clobbered', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    // The user's own skill occupies the pack skill's name: no lock entry and no
    // `metadata.pack` self-identification, so provenance says it is not ours.
    const dir = join(proj, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    const mine = `---\nname: ${name}\ndescription: mine\n---\nmine\n`;
    writeFileSync(join(dir, 'SKILL.md'), mine, 'utf-8');

    const result = await installPackSkill(proj, 'knowledge-base');
    expect(result.conflicts.map((c) => c.name)).toContain(name);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(mine);
  });

  test('refuses to install through an editor dir that symlinks outside the project', async () => {
    const proj = tmpProject();
    const outside = tmpProject();
    const name = orientationName('knowledge-base');
    // `.claude` resolves outside the project; the platform skill is present
    // there, so we reach (and must be stopped by) the symlink-escape guard.
    symlinkSync(outside, join(proj, '.claude'));
    mkdirSync(join(outside, 'skills', 'open-knowledge'), { recursive: true });
    writeFileSync(join(outside, 'skills', 'open-knowledge', 'SKILL.md'), '# platform\n');
    expect((await installPackSkill(proj, 'knowledge-base')).editors).toEqual([]);
    expect(existsSync(join(outside, 'skills', name))).toBe(false);
    // The escaping root is ALSO the would-be default home — the whole install
    // is refused (never author through an out-of-project symlink).
    expect(readInstalledSkills(proj).skills[name]).toBeUndefined();
  });
});

describe('installPackSkill — an install under the old name is left alone', () => {
  // We deliberately do NOT rename skills people are already using: these are
  // project-level, so the directory is normally committed and a silent rename
  // is an unexplained diff for them and everyone who pulls. The install must
  // therefore read as present, so seeding never authors a second copy of the
  // same skill under the new name.
  const OLD = 'open-knowledge-pack-plain-notes';

  test('no duplicate is authored beside it, and no conflict is reported', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const newName = orientationName('plain-notes');
    expect(newName).not.toBe(OLD);
    const oldDir = join(proj, '.claude/skills', OLD);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, 'SKILL.md'),
      `---\nname: ${OLD}\ndescription: "Plain notes."\nmetadata:\n  pack: "plain-notes"\n---\n\nMine now.\n`,
    );

    const result = await installPackSkill(proj, 'plain-notes');

    expect(existsSync(join(proj, '.claude/skills', newName, 'SKILL.md'))).toBe(false);
    expect(result.conflicts).toEqual([]);
    // Untouched, still theirs, still under the name they know.
    expect(readFileSync(join(oldDir, 'SKILL.md'), 'utf-8')).toContain('Mine now.');
    rmSync(proj, { recursive: true, force: true });
  });

  // Skipping the whole loop body for a legacy install would also skip fan-out,
  // silently regressing an editor set up AFTER the install: seeding would report
  // "already set up" and leave that editor without the skill.
  test('still fans out into an editor set up after it was installed', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    setUpEditor(proj, '.cursor');
    const oldDir = join(proj, '.claude/skills', OLD);
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, 'SKILL.md'),
      `---\nname: ${OLD}\ndescription: "Plain notes."\nmetadata:\n  pack: "plain-notes"\n---\n\nBody.\n`,
    );

    const result = await installPackSkill(proj, 'plain-notes');

    // Projected under the name it actually has, into the newly set-up editor.
    expect(existsSync(join(proj, '.cursor/skills', OLD, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.cursor/skills', orientationName('plain-notes')))).toBe(false);
    expect(result.editors).toContain('Cursor');
    rmSync(proj, { recursive: true, force: true });
  });
});

describe('classifyPresentPackSkill — ours-retrofit', () => {
  // A pack skill installed before provenance was recorded has no lock entry, so
  // the lock cannot vouch for it. Its own frontmatter `metadata.pack` is the
  // only remaining witness that OK authored it. Without this branch such an
  // install reads as a stranger's skill and the rename declines to touch it.
  test('no lock entry but matching metadata.pack reads as ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-classify-'));
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: note-taking\ndescription: "x"\nmetadata:\n  pack: "plain-notes"\n---\n',
    );
    expect(
      classifyPresentPackSkill('plain-notes', 'note-taking', dir, { schema: 1, skills: {} }),
    ).toBe('ours-retrofit');
    rmSync(dir, { recursive: true, force: true });
  });

  test("another pack's id in the frontmatter is not ours", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-classify-'));
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: note-taking\nmetadata:\n  pack: "worldbuilding"\n---\n',
    );
    expect(
      classifyPresentPackSkill('plain-notes', 'note-taking', dir, { schema: 1, skills: {} }),
    ).toBe('foreign');
    rmSync(dir, { recursive: true, force: true });
  });

  test('an unreadable or absent bundle is undecidable, never ours', () => {
    expect(
      classifyPresentPackSkill('plain-notes', 'note-taking', join(tmpdir(), 'ok-nope-missing'), {
        schema: 1,
        skills: {},
      }),
    ).toBe('foreign');
  });

  // The lock keeps the raw source the user came in through. The same bundle
  // records the bare repo when seeded and a skills.sh URL when installed from
  // the listing, so an exact match reports OK's own skill as the user's name
  // collision — on the very flow the published listings exist for.
  test('a skills.sh URL naming the OK skills repo still reads as ours', () => {
    const lock = {
      schema: 1 as const,
      skills: {
        'note-taking': {
          source: 'https://skills.sh/inkeep/open-knowledge-skills/note-taking',
          skill: 'note-taking',
          contentHash: 'h',
          importedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    expect(classifyPresentPackSkill('plain-notes', 'note-taking', null, lock)).toBe('ours');
  });

  test("a genuinely foreign import source is still the user's", () => {
    const lock = {
      schema: 1 as const,
      skills: {
        'note-taking': {
          source: 'someone-else/skills',
          skill: 'note-taking',
          contentHash: 'h',
          importedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    expect(classifyPresentPackSkill('plain-notes', 'note-taking', null, lock)).toBe('foreign');
  });

  // The retrofit verdict is what writes OK provenance onto a skill, and that
  // provenance is what a later "Update from source" reimports over. A skill
  // that merely DOCUMENTS a pack must never buy it.
  test('a pack id in the body, not the frontmatter, is not ours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-classify-'));
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: note-taking',
        'description: "My own notes skill."',
        '---',
        '',
        'Starter packs declare their id in frontmatter, like:',
        '',
        '```yaml',
        'metadata:',
        '  pack: "plain-notes"',
        '```',
        '',
      ].join('\n'),
    );
    expect(
      classifyPresentPackSkill('plain-notes', 'note-taking', dir, { schema: 1, skills: {} }),
    ).toBe('foreign');
    rmSync(dir, { recursive: true, force: true });
  });
});
