import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENKNOWLEDGE_SKILLS_REPO } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { readInstalledSkills } from '../installed-skills-marker.ts';
import { installPackSkill, resolvePackSkillSources } from './install-pack-skill.ts';

/** Simulate `ok init` having installed the platform skill for an editor dir. */
function setUpEditor(proj: string, editorDir: string): void {
  const platformDir = join(proj, editorDir, 'skills', 'open-knowledge');
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, 'SKILL.md'), '# platform\n');
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ok-seed-skill-'));
}

describe('installPackSkill', () => {
  test('authors the pack skill IN PLACE at the default home (store retirement)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const installed = await installPackSkill(proj, 'knowledge-base');
    expect(installed).toEqual(['Claude Code']);
    // The source lands at the project's default skill home (here `.claude/
    // skills` — the first existing editor root), NOT the retired `.ok/skills`
    // store. The scan is the host-set truth; no install marker is written.
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-knowledge-base', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(proj, '.ok', 'skills', 'open-knowledge-pack-knowledge-base'))).toBe(
      false,
    );
    expect(readInstalledSkills(proj).skills['open-knowledge-pack-knowledge-base']).toBeUndefined();
  });

  test('records skills.sh provenance in .ok/skills-lock.json for reimport', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    await installPackSkill(proj, 'knowledge-base');
    // Provenance makes a seeded pack update through the SAME reimport path as any
    // imported skill: deterministic source (the open-knowledge-skills projection),
    // the skill selector is the skill's own name, plus its content hash.
    const lock = JSON.parse(readFileSync(join(proj, '.ok', 'skills-lock.json'), 'utf-8')) as {
      skills: Record<string, { source: string; skill: string; contentHash: string }>;
    };
    const entry = lock.skills['open-knowledge-pack-knowledge-base'];
    expect(entry).toBeDefined();
    expect(entry.source).toBe(OPENKNOWLEDGE_SKILLS_REPO);
    expect(entry.skill).toBe('open-knowledge-pack-knowledge-base');
    expect(entry.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('installs for every set-up editor (claude + cursor + codex)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    setUpEditor(proj, '.cursor');
    setUpEditor(proj, '.codex');
    expect((await installPackSkill(proj, 'entity-vault')).sort()).toEqual([
      'Claude Code',
      'Codex',
      'Cursor',
    ]);
    // Source at the default home; real copies fanned to the other editors.
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-entity-vault', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(proj, '.cursor', 'skills', 'open-knowledge-pack-entity-vault', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(proj, '.codex', 'skills', 'open-knowledge-pack-entity-vault', 'SKILL.md')),
    ).toBe(true);
  });

  test('installs the codebase-wiki pack skill from the source assets', async () => {
    // Confirms the new pack's SKILL.md asset resolves through the bundled-skill
    // probe (source `assets/skills/packs/codebase-wiki/` when no built dist).
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    expect(await installPackSkill(proj, 'codebase-wiki')).toEqual(['Claude Code']);
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-codebase-wiki', 'SKILL.md')),
    ).toBe(true);
  });

  test('a decomposed pack installs its root skill plus every member skill', async () => {
    // `software-lifecycle` ships an orientation SKILL.md at the pack root plus one
    // scenario skill per subdirectory. Each installs as its own top-level skill
    // (name == leaf dir, per the Agent Skills standard).
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
    expect(await installPackSkill(proj, 'software-lifecycle')).toEqual(['Claude Code']);

    for (const { name } of sources) {
      expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    }
    // The root skill's copy carries no member subdirectory — that would ship each
    // scenario skill twice, once nested inside a skill that is not its own.
    const root = sources.find((s) => s.name === 'open-knowledge-pack-software-lifecycle');
    expect(root).toBeDefined();
    for (const member of root?.excludeDirs ?? []) {
      expect(existsSync(join(proj, '.claude', 'skills', root?.name ?? '', member))).toBe(false);
    }
  });

  test('no editor set up: the source is still authored at the fallback home', async () => {
    const proj = tmpProject();
    // No set-up editor → nothing fanned/labelled, but the source still lands
    // (default fallback home) so the skill lists for that folder's agent.
    expect(await installPackSkill(proj, 'knowledge-base')).toEqual([]);
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-knowledge-base', 'SKILL.md')),
    ).toBe(true);
    expect(readInstalledSkills(proj).skills['open-knowledge-pack-knowledge-base']).toBeUndefined();
  });

  test('no-op for a pack that ships no skill', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    expect(await installPackSkill(proj, 'no-such-pack')).toEqual([]);
    // Ships no skill → nothing authored.
    expect(existsSync(join(proj, '.ok', 'skills', 'open-knowledge-pack-no-such-pack'))).toBe(false);
  });

  test('re-seed preserves a user-edited pack skill (no rm+cp clobber)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    // First install authors the shipped source.
    await installPackSkill(proj, 'knowledge-base');
    const sourcePath = join(
      proj,
      '.claude',
      'skills',
      'open-knowledge-pack-knowledge-base',
      'SKILL.md',
    );
    expect(existsSync(sourcePath)).toBe(true);

    // The pack skill is now the user's fork — they edit it.
    const edited =
      '---\nname: open-knowledge-pack-knowledge-base\ndescription: my edit\n---\nmine\n';
    writeFileSync(sourcePath, edited, 'utf-8');

    // Re-running seed (CLI / desktop IPC / HTTP all funnel here) must NOT reset
    // the source back to the shipped body. Projection + marker still refresh.
    const installed = await installPackSkill(proj, 'knowledge-base');
    expect(installed).toEqual(['Claude Code']);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(edited);
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-knowledge-base', 'SKILL.md')),
    ).toBe(true);
  });

  test('refuses to install through an editor dir that symlinks outside the project', async () => {
    const proj = tmpProject();
    const outside = tmpProject();
    // `.claude` resolves outside the project; the platform skill is present
    // there, so we reach (and must be stopped by) the symlink-escape guard.
    symlinkSync(outside, join(proj, '.claude'));
    mkdirSync(join(outside, 'skills', 'open-knowledge'), { recursive: true });
    writeFileSync(join(outside, 'skills', 'open-knowledge', 'SKILL.md'), '# platform\n');
    expect(await installPackSkill(proj, 'knowledge-base')).toEqual([]);
    expect(existsSync(join(outside, 'skills', 'open-knowledge-pack-knowledge-base'))).toBe(false);
    // The escaping root is ALSO the would-be default home — the whole install
    // is refused (never author through an out-of-project symlink).
    expect(readInstalledSkills(proj).skills['open-knowledge-pack-knowledge-base']).toBeUndefined();
  });
});
