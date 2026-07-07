import { describe, expect, test } from 'bun:test';
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
import { readInstalledSkills } from '../installed-skills-marker.ts';
import { installPackSkill } from './install-pack-skill.ts';

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
  test('authors the pack skill into .ok/skills + installs it for a set-up editor', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const installed = await installPackSkill(proj, 'knowledge-base');
    expect(installed).toEqual(['Claude Code']);
    // (1) Source under `.ok/skills/` — this is what makes it show in the Skills
    // list + be editable (the fork model).
    expect(
      existsSync(join(proj, '.ok', 'skills', 'open-knowledge-pack-knowledge-base', 'SKILL.md')),
    ).toBe(true);
    // (2) Projected into the editor host dir.
    expect(
      existsSync(join(proj, '.claude', 'skills', 'open-knowledge-pack-knowledge-base', 'SKILL.md')),
    ).toBe(true);
    // (3) marker records it Installed with its hosts — so the list badges
    // it Installed and the Uninstall action can demote it back to a Draft.
    const marker = readInstalledSkills(proj).skills['open-knowledge-pack-knowledge-base'];
    expect(marker).toBeDefined();
    expect(marker?.scope).toBe('project');
    expect(marker?.hosts).toEqual(['claude']);
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
    const marker = readInstalledSkills(proj).skills['open-knowledge-pack-entity-vault'];
    expect(marker?.hosts.sort()).toEqual(['claude', 'codex', 'cursor']);
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

  test('no-op when no editor is set up (no platform skill present)', async () => {
    const proj = tmpProject();
    // The source is still authored (so it lists), but no editor → no install,
    // no marker. It shows as a Draft.
    expect(await installPackSkill(proj, 'knowledge-base')).toEqual([]);
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
      '.ok',
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
    // No editor projection happened, so no marker — but the source was still
    // authored into the project's own `.ok/skills/`.
    expect(readInstalledSkills(proj).skills['open-knowledge-pack-knowledge-base']).toBeUndefined();
  });
});
