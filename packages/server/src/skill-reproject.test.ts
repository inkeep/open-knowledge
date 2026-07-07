import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { projectSkill } from './skill-projection.ts';
import { reprojectAllManagedSkills } from './skill-reproject.ts';

let root: string;
let skillsRoot: string;

/** Author a managed source skill under `.ok/skills/<name>`, frontmatter name = folder. */
function makeSource(name: string, frontmatterName = name): string {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${frontmatterName}\ndescription: Use when testing.\n---\n# Steps`,
  );
  return dir;
}

/** Install a project-scope skill's marker entry + symlink projections. */
async function install(name: string, hosts: ReadonlyArray<'claude' | 'cursor' | 'codex'>) {
  projectSkill(join(skillsRoot, name), name, root, hosts);
  await recordSkillInstall(root, name, {
    hosts: [...hosts],
    scope: 'project',
    scripts: false,
    installedAt: new Date('2026-06-25T00:00:00.000Z').toISOString(),
  });
}

const projected = (editorRel: string, name: string): boolean =>
  existsSync(join(root, editorRel, name, 'SKILL.md'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-reproject-'));
  skillsRoot = join(root, '.ok', 'skills');
  mkdirSync(skillsRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reprojectAllManagedSkills', () => {
  test('drops only the no-longer-targeted hosts for a valid source', async () => {
    makeSource('alpha');
    await install('alpha', ['claude', 'cursor']);
    expect(projected('.claude/skills', 'alpha')).toBe(true);
    expect(projected('.cursor/skills', 'alpha')).toBe(true);

    const r = await reprojectAllManagedSkills({
      projectDir: root,
      skillsRoot,
      targets: ['claude'],
    });

    expect(r.reprojected).toContainEqual({ name: 'alpha', hosts: ['claude'] });
    expect(projected('.claude/skills', 'alpha')).toBe(true);
    expect(projected('.cursor/skills', 'alpha')).toBe(false);
    expect(readInstalledSkills(root).skills.alpha?.hosts).toEqual(['claude']);
  });

  test('source-gone skill reverses from ALL recorded hosts, even a still-targeted one', async () => {
    makeSource('beta');
    await install('beta', ['claude']);
    expect(projected('.claude/skills', 'beta')).toBe(true);
    // Source disappears after install (native delete of `.ok/skills/beta`).
    rmSync(join(skillsRoot, 'beta'), { recursive: true, force: true });

    // `claude` is STILL in targets, yet the projection must be torn down because
    // the source is gone — otherwise the link lingers while the marker reads [].
    const r = await reprojectAllManagedSkills({
      projectDir: root,
      skillsRoot,
      targets: ['claude'],
    });

    expect(r.reprojected).toContainEqual({ name: 'beta', hosts: [] });
    expect(projected('.claude/skills', 'beta')).toBe(false);
    expect(readInstalledSkills(root).skills.beta?.hosts).toEqual([]);
  });

  test('per-skill isolation: an invalid source does not abort the valid one', async () => {
    makeSource('valid-one');
    await install('valid-one', ['claude']);
    // Invalid: frontmatter.name ≠ folder name (the bypass guard rejects it).
    makeSource('mismatch', 'totally-different');
    await install('mismatch', ['claude', 'cursor']);

    const r = await reprojectAllManagedSkills({
      projectDir: root,
      skillsRoot,
      targets: ['claude', 'cursor'],
    });

    // Valid skill projected to the full target set.
    expect(r.reprojected).toContainEqual({ name: 'valid-one', hosts: ['claude', 'cursor'] });
    expect(projected('.claude/skills', 'valid-one')).toBe(true);
    expect(projected('.cursor/skills', 'valid-one')).toBe(true);
    // Invalid skill left un-projected (zero hosts), reversed from all recorded.
    expect(r.reprojected).toContainEqual({ name: 'mismatch', hosts: [] });
    expect(projected('.claude/skills', 'mismatch')).toBe(false);
    expect(projected('.cursor/skills', 'mismatch')).toBe(false);
    expect(readInstalledSkills(root).skills.mismatch?.hosts).toEqual([]);
  });

  test('global-scope marker entries are skipped (store not wired)', async () => {
    makeSource('personal-skill');
    await recordSkillInstall(root, 'personal-skill', {
      hosts: ['claude'],
      scope: 'global',
      scripts: false,
      installedAt: new Date('2026-06-25T00:00:00.000Z').toISOString(),
    });

    const r = await reprojectAllManagedSkills({
      projectDir: root,
      skillsRoot,
      targets: ['claude'],
    });

    expect(r.reprojected.find((s) => s.name === 'personal-skill')).toBeUndefined();
  });
});
