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
import { OPENKNOWLEDGE_SKILLS_REPO, RENAMED_PACK_SKILLS } from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { readInstalledSkills } from '../installed-skills-marker.ts';
import {
  classifyPresentPackSkill,
  installPackSkill,
  installPackSkillOnDemand,
  resolvePackSkillSources,
} from './install-pack-skill.ts';

function setUpEditor(proj: string, editorDir: string): void {
  const platformDir = join(proj, editorDir, 'skills', 'open-knowledge');
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, 'SKILL.md'), '# platform\n');
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'ok-seed-skill-'));
}

function orientationName(packId: string): string {
  const [first] = resolvePackSkillSources(packId);
  expect(first).toBeDefined();
  return (first as { name: string }).name;
}

describe('installPackSkill', () => {
  test('published Knowledge Base and OKF skill IDs stay stable for skills.sh updates', () => {
    expect(resolvePackSkillSources('knowledge-base').map(({ name }) => name)).toEqual([
      'knowledge-base',
      'consolidate-notes',
      'research-with-sources',
    ]);
    expect(resolvePackSkillSources('okf').map(({ name }) => name)).toEqual(['okf-knowledge-base']);
    expect(RENAMED_PACK_SKILLS['open-knowledge-pack-okf']).toBe('okf-knowledge-base');
  });

  test('on-demand install reports a newly-authored OKF skill', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');

    const result = await installPackSkillOnDemand(proj, 'okf');

    expect(result).toEqual({
      installedHosts: ['Claude Code'],
      skills: [{ name: 'okf-knowledge-base', created: true }],
    });
    expect(existsSync(join(proj, '.claude', 'skills', 'okf-knowledge-base', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('on-demand install recognizes and preserves an existing same-name skill', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const skillDir = join(proj, '.claude', 'skills', 'okf-knowledge-base');
    mkdirSync(skillDir, { recursive: true });
    const authored =
      '---\nname: okf-knowledge-base\ndescription: team guidance\n---\nDo not replace me.\n';
    writeFileSync(join(skillDir, 'SKILL.md'), authored, 'utf-8');

    const result = await installPackSkillOnDemand(proj, 'okf');

    expect(result).toEqual({
      installedHosts: [],
      skills: [{ name: 'okf-knowledge-base', created: false }],
    });
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(authored);
  });

  test('authors the pack skill IN PLACE at the default home (store retirement)', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    const result = await installPackSkill(proj, 'knowledge-base');
    expect(result.editors).toEqual(['Claude Code']);
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    expect(readInstalledSkills(proj).skills[name]).toBeUndefined();
  });

  test('records skills.sh provenance in .ok/skills-lock.json for reimport', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    await installPackSkill(proj, 'knowledge-base');
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
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.cursor', 'skills', name, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.codex', 'skills', name, 'SKILL.md'))).toBe(true);
  });

  test('installs the codebase-wiki pack skill from the source assets', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('codebase-wiki');
    expect((await installPackSkill(proj, 'codebase-wiki')).editors).toEqual(['Claude Code']);
    expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
  });

  test('a decomposed pack installs its root skill plus every member skill', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const sources = resolvePackSkillSources('software-lifecycle');
    expect(sources.length).toBeGreaterThan(0);
    expect((await installPackSkill(proj, 'software-lifecycle')).editors).toEqual(['Claude Code']);

    for (const { name } of sources) {
      expect(existsSync(join(proj, '.claude', 'skills', name, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(proj, '.ok', 'skills', name))).toBe(false);
    }
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
    await installPackSkill(proj, 'knowledge-base');
    const sourcePath = join(proj, '.claude', 'skills', name, 'SKILL.md');
    expect(existsSync(sourcePath)).toBe(true);

    const edited = `---\nname: ${name}\ndescription: my edit\n---\nmine\n`;
    writeFileSync(sourcePath, edited, 'utf-8');

    const result = await installPackSkill(proj, 'knowledge-base');
    expect(result.editors).toEqual(['Claude Code']);
    expect(result.conflicts.map((c) => c.name)).not.toContain(name);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(edited);
  });

  test('a user-owned same-named skill is a reported conflict, never clobbered', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
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
    symlinkSync(outside, join(proj, '.claude'));
    mkdirSync(join(outside, 'skills', 'open-knowledge'), { recursive: true });
    writeFileSync(join(outside, 'skills', 'open-knowledge', 'SKILL.md'), '# platform\n');
    expect((await installPackSkill(proj, 'knowledge-base')).editors).toEqual([]);
    expect(existsSync(join(outside, 'skills', name))).toBe(false);
    expect(readInstalledSkills(proj).skills[name]).toBeUndefined();
  });
});

describe('installPackSkill — an install under the old name is left alone', () => {
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
    expect(readFileSync(join(oldDir, 'SKILL.md'), 'utf-8')).toContain('Mine now.');
    rmSync(proj, { recursive: true, force: true });
  });

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

    expect(existsSync(join(proj, '.cursor/skills', OLD, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(proj, '.cursor/skills', orientationName('plain-notes')))).toBe(false);
    expect(result.editors).toContain('Cursor');
    rmSync(proj, { recursive: true, force: true });
  });
});

describe('classifyPresentPackSkill — ours-retrofit', () => {
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

describe('installPackSkill — a copy that fails partway does not wedge the skill', () => {
  test('rolls the partial tree back so a later seed retries instead of reading it as present', async () => {
    const proj = tmpProject();
    setUpEditor(proj, '.claude');
    const name = orientationName('knowledge-base');
    const skillDir = join(proj, '.claude', 'skills', name);

    const copyDir = await import('../copy-dir.ts');
    const real = copyDir.copyDirSync;
    const spy = vi.spyOn(copyDir, 'copyDirSync').mockImplementationOnce((_src, dest) => {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), '---\nname: half\n---\npartial\n');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    await installPackSkill(proj, 'knowledge-base');
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(false);

    spy.mockRestore();
    expect(copyDir.copyDirSync).toBe(real);
    await installPackSkill(proj, 'knowledge-base');
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).not.toContain('partial');
  });
});
