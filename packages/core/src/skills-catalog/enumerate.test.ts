import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { enumerateInstalledSkills } from './enumerate.ts';

function writeSkill(dir: string, frontmatter: string | null, body = 'Body.'): void {
  mkdirSync(dir, { recursive: true });
  const content = frontmatter === null ? body : `---\n${frontmatter}\n---\n\n${body}\n`;
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8');
}

function hashTree(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${p}\n${readFileSync(p)}\n`);
    }
  };
  walk(root);
  return h.digest('hex');
}

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-skills-catalog-'));

  const pluginsDir = join(home, '.claude', 'plugins');
  const cache = join(pluginsDir, 'cache', 'inkeep-team-skills', 'eng');
  const activePath = join(cache, '2.0.0');
  const oldPath = join(cache, '1.0.0');
  const orphanPath = join(cache, '9.9.9');

  mkdirSync(join(activePath, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(activePath, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'eng',
      description: 'Eng skills',
      version: '2.0.0',
      author: { name: 'Inkeep' },
    }),
    'utf-8',
  );
  mkdirSync(join(activePath, 'commands'), { recursive: true });
  mkdirSync(join(activePath, 'hooks'), { recursive: true });
  writeFileSync(join(activePath, '.mcp.json'), '{}', 'utf-8');
  writeSkill(join(activePath, 'skills', 'alpha'), 'name: alpha\ndescription: Alpha skill');
  writeSkill(
    join(activePath, 'skills', 'shared-skill'),
    'name: shared-skill\ndescription: Shared from plugin',
  );
  writeSkill(join(activePath, 'skills', 'malformed'), 'name: [unterminated\n  : : :');
  mkdirSync(join(activePath, 'skills', 'no-md'), { recursive: true });

  writeSkill(join(oldPath, 'skills', 'ghost'), 'name: ghost\ndescription: should not appear');

  writeSkill(
    join(orphanPath, 'skills', 'orphan-skill'),
    'name: orphan-skill\ndescription: should not appear',
  );

  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'eng@inkeep-team-skills': [
          {
            scope: 'project',
            projectPath: '/proj',
            installPath: activePath,
            version: '2.0.0',
            gitCommitSha: 'abc123',
            lastUpdated: '2026-06-29T00:00:00.000Z',
          },
          {
            scope: 'project',
            projectPath: '/proj',
            installPath: oldPath,
            version: '1.0.0',
            gitCommitSha: 'old000',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
          {
            scope: 'project',
            projectPath: '/proj',
            installPath: orphanPath,
            version: '9.9.9',
            lastUpdated: '2026-12-31T00:00:00.000Z',
            orphaned_at: '2026-12-31T00:00:00.000Z',
          },
        ],
      },
    }),
    'utf-8',
  );

  writeSkill(
    join(home, '.codex', 'skills', 'shared-skill'),
    'name: shared-skill\ndescription: Shared bare skill',
  );
  writeSkill(
    join(home, '.opencode', 'skills', 'shared-skill'),
    'name: shared-skill\ndescription: Shared bare skill',
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('enumerateInstalledSkills', () => {
  test('produces normalized, de-duped, sorted skills + packs', () => {
    const { skills, packs } = enumerateInstalledSkills({ home });
    const names = skills.map((s) => s.name);

    expect(names).toEqual(['alpha', 'malformed', 'shared-skill', 'shared-skill']);
    expect(names).not.toContain('ghost');
    expect(names).not.toContain('orphan-skill');

    const alpha = skills.find((s) => s.name === 'alpha');
    expect(alpha?.description).toBe('Alpha skill');

    const malformed = skills.find((s) => s.name === 'malformed');
    expect(malformed).toBeDefined();
    expect(malformed?.description).toBe('');

    expect(alpha?.inert).toEqual({ commands: true, hooks: true, mcp: true });

    expect(alpha?.provenance).toMatchObject({
      plugin: 'eng',
      marketplace: 'inkeep-team-skills',
      version: '2.0.0',
      gitCommitSha: 'abc123',
      scope: 'project',
      projectPath: '/proj',
    });

    const shared = skills.filter((s) => s.name === 'shared-skill');
    expect(shared).toHaveLength(2);
    expect(shared.find((s) => s.provenance.plugin === 'eng')?.sourceHarnesses).toEqual(['claude']);
    expect(shared.find((s) => s.provenance.plugin === undefined)?.sourceHarnesses).toEqual([
      'codex',
      'opencode',
    ]);
    expect(shared.find((s) => s.provenance.plugin === 'eng')?.inert).toEqual({
      commands: true,
      hooks: true,
      mcp: true,
    });

    const codexOnly = enumerateInstalledSkills({ home }).skills;
    expect(codexOnly).toEqual(skills);

    expect(packs.map((p) => p.name)).toEqual(['eng', 'shared-skill']);
    const eng = packs.find((p) => p.name === 'eng');
    expect(eng?.version).toBe('2.0.0');
    expect(eng?.description).toBe('Eng skills');
    expect(eng?.author).toEqual({ name: 'Inkeep' });
    expect(eng?.skills).toEqual(['alpha', 'malformed', 'shared-skill']);
    expect(eng?.hostCompatibility).toEqual(['claude']);

    const sharedPack = packs.find((p) => p.name === 'shared-skill');
    expect(sharedPack?.hostCompatibility).toEqual(['codex', 'opencode']);
  });

  test('is read-only — fixture byte-identical before/after', () => {
    const before = hashTree(home);
    enumerateInstalledSkills({ home });
    expect(hashTree(home)).toBe(before);
  });

  test('project-local enumeration drops foreign plugin skills and their pack', () => {
    const result = enumerateInstalledSkills({ home, projectDir: '/different-project' });

    expect(result.skills.map((s) => s.name)).not.toContain('alpha');
    expect(result.packs.map((pack) => pack.name)).not.toContain('eng');
    expect(result.skills.filter((s) => s.name === 'shared-skill')).toHaveLength(1);
  });

  test('empty home → empty result', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ok-skills-empty-'));
    try {
      expect(enumerateInstalledSkills({ home: empty })).toEqual({ skills: [], packs: [] });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

test('a broken harness home is skipped; sibling homes still enumerate', () => {
  const h = mkdtempSync(join(tmpdir(), 'ok-degrade-'));
  mkdirSync(join(h, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(h, '.claude', 'plugins', 'installed_plugins.json'),
    '{ not valid json',
    'utf-8',
  );
  writeSkill(join(h, '.codex', 'skills', 'survivor'), 'name: survivor\ndescription: still here');
  const res = enumerateInstalledSkills({ home: h });
  rmSync(h, { recursive: true, force: true });
  expect(res.skills.map((sk) => sk.name)).toContain('survivor');
});

describe('enumerateInstalledSkills — projectDir (harness-symmetric project detection)', () => {
  let emptyHome: string;
  let proj: string;

  beforeAll(() => {
    emptyHome = mkdtempSync(join(tmpdir(), 'ok-skills-emptyhome-'));
    proj = mkdtempSync(join(tmpdir(), 'ok-skills-proj-'));
    writeSkill(
      join(proj, '.codex', 'skills', 'proj-only'),
      'name: proj-only\ndescription: Codex-local',
    );
    writeSkill(join(proj, '.codex', 'skills', 'dup'), 'name: dup\ndescription: same');
    writeSkill(join(proj, '.claude', 'skills', 'dup'), 'name: dup\ndescription: same');
    writeSkill(join(proj, '.ok', 'skills', 'mine'), 'name: mine\ndescription: OK-managed');
    mkdirSync(join(proj, '.claude', 'skills'), { recursive: true });
    symlinkSync(
      join(proj, '.ok', 'skills', 'mine'),
      join(proj, '.claude', 'skills', 'mine'),
      'dir',
    );
    writeSkill(
      join(proj, '.claude', 'skills', 'open-knowledge'),
      'name: open-knowledge\ndescription: shipped bundle',
    );
  });

  afterAll(() => {
    rmSync(emptyHome, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  test('a project harness skill buckets as project (scope + projectPath stamped), not global', () => {
    const { skills } = enumerateInstalledSkills({ home: emptyHome, projectDir: proj });
    const row = skills.find((s) => s.name === 'proj-only');
    expect(row).toBeDefined();
    expect(row?.provenance.scope).toBe('project');
    expect(row?.provenance.projectPath).toBe(proj);
    expect(row?.sourceHarnesses).toEqual(['codex']);
  });

  test('same-named skill across two project harnesses collapses to one row', () => {
    const { skills } = enumerateInstalledSkills({ home: emptyHome, projectDir: proj });
    const rows = skills.filter((s) => s.name === 'dup');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceHarnesses).toEqual(['claude', 'codex']);
  });

  test('OK-owned projections (symlink into .ok/skills, reserved bundle name) are excluded', () => {
    const { skills } = enumerateInstalledSkills({ home: emptyHome, projectDir: proj });
    const names = skills.map((s) => s.name);
    expect(names).not.toContain('mine');
    expect(names).not.toContain('open-knowledge');
  });

  test('without projectDir, no project harness skills surface', () => {
    const { skills } = enumerateInstalledSkills({ home: emptyHome });
    expect(skills.map((s) => s.name)).not.toContain('proj-only');
  });

  test('suffix-mismatched names do NOT dedup-collapse — they stay two distinct rows', () => {
    const p = mkdtempSync(join(tmpdir(), 'ok-skills-suffix-'));
    try {
      writeSkill(join(p, '.codex', 'skills', 'foo'), 'name: foo\ndescription: base');
      writeSkill(
        join(p, '.codex', 'skills', 'foo-codex'),
        'name: foo-codex\ndescription: suffixed',
      );
      const { skills } = enumerateInstalledSkills({ home: emptyHome, projectDir: p });
      const names = skills.map((s) => s.name);
      expect(names).toContain('foo');
      expect(names).toContain('foo-codex');
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test('same-scoped, same-named bundles with different bytes remain distinct forks', () => {
    const p = mkdtempSync(join(tmpdir(), 'ok-skills-forks-'));
    try {
      writeSkill(join(p, '.codex', 'skills', 'fork'), 'name: fork\ndescription: codex', '# A');
      writeSkill(join(p, '.claude', 'skills', 'fork'), 'name: fork\ndescription: claude', '# B');

      const rows = enumerateInstalledSkills({ home: emptyHome, projectDir: p }).skills.filter(
        (s) => s.name === 'fork',
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((s) => s.sourceHarnesses)).toEqual([['claude'], ['codex']]);
    } finally {
      rmSync(p, { recursive: true, force: true });
    }
  });

  test('byte-identical project and global skills remain separate identities', () => {
    const h = mkdtempSync(join(tmpdir(), 'ok-skills-scope-home-'));
    const p = mkdtempSync(join(tmpdir(), 'ok-skills-scope-project-'));
    try {
      const frontmatter = 'name: scoped\ndescription: same bytes';
      writeSkill(join(h, '.codex', 'skills', 'scoped'), frontmatter);
      writeSkill(join(p, '.codex', 'skills', 'scoped'), frontmatter);

      const rows = enumerateInstalledSkills({ home: h, projectDir: p }).skills.filter(
        (s) => s.name === 'scoped',
      );

      expect(rows).toHaveLength(2);
      expect(rows.map((s) => s.provenance.scope ?? 'global').sort()).toEqual(['global', 'project']);
    } finally {
      rmSync(h, { recursive: true, force: true });
      rmSync(p, { recursive: true, force: true });
    }
  });
});
