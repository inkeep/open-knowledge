import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { planSeed } from './plan.ts';
import { STARTER_PACKS } from './starter.ts';
import { SeedPrerequisiteError, SeedRootDirError } from './types.ts';

const STARTER_FOLDERS = STARTER_PACKS['knowledge-base'].folders;

describe('planSeed — nested .ok/ era', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-plan-'));
    // Simulate `ok init` having created `.ok/config.yml` already — the
    // canonical project-root marker.
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('throws SeedPrerequisiteError when .ok/config.yml is absent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-bare-'));
    try {
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(SeedPrerequisiteError);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('throws SeedPrerequisiteError when .ok/ exists but config.yml is absent', async () => {
    // Mimics a nested folder-rule sidecar — `.ok/` with no `config.yml`.
    // The gate must reject this, not accept it as a valid project root.
    const bare = await mkdtemp(join(tmpdir(), 'seed-sidecar-'));
    try {
      mkdirSync(join(bare, '.ok'), { recursive: true });
      writeFileSync(join(bare, '.ok', 'frontmatter.yml'), 'title: x\n', 'utf-8');
      await expect(planSeed({ projectDir: bare })).rejects.toThrow(SeedPrerequisiteError);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('skipPrerequisite bypasses the gate — previews an all-created plan in a bare dir', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'seed-preview-'));
    try {
      const plan = await planSeed({ projectDir: bare, skipPrerequisite: true });
      expect(plan.created.length).toBeGreaterThan(0);
      expect(plan.skipped.length).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test('plans every starter folder + nested .ok/ + frontmatter.yml + templates/<name>.md', async () => {
    const plan = await planSeed({ projectDir });
    const createdPaths = new Set(plan.created.map((e) => e.path));

    for (const folder of STARTER_FOLDERS) {
      expect(createdPaths.has(folder.path)).toBe(true); // the folder itself
      expect(createdPaths.has(`${folder.path}/.ok`)).toBe(true); // nested .ok/
      expect(createdPaths.has(`${folder.path}/.ok/frontmatter.yml`)).toBe(true);
      expect(createdPaths.has(`${folder.path}/.ok/templates`)).toBe(true);
      expect(createdPaths.has(`${folder.path}/.ok/templates/${folder.starterTemplate}.md`)).toBe(
        true,
      );
    }
    // Plus root log.md.
    expect(createdPaths.has('log.md')).toBe(true);
  });

  test('plan has no configEdits field — folders[] write path retired (FR8 / D19)', async () => {
    const plan = await planSeed({ projectDir });
    expect((plan as unknown as Record<string, unknown>).configEdits).toBeUndefined();
  });

  test('frontmatter.yml + template entries carry their template id for apply()', async () => {
    const plan = await planSeed({ projectDir });
    for (const folder of STARTER_FOLDERS) {
      const fmEntry = plan.created.find((e) => e.path === `${folder.path}/.ok/frontmatter.yml`);
      expect(fmEntry?.template).toBe(`${folder.path}/.ok/frontmatter.yml`);

      const tplEntry = plan.created.find(
        (e) => e.path === `${folder.path}/.ok/templates/${folder.starterTemplate}.md`,
      );
      expect(tplEntry?.template).toBe(`${folder.path}/.ok/templates/${folder.starterTemplate}.md`);
    }
  });

  test('skips entries that already exist on disk', async () => {
    // Pre-create one folder + its nested frontmatter.
    mkdirSync(join(projectDir, 'external-sources', '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, 'external-sources', '.ok', 'frontmatter.yml'),
      'title: User had this already\n',
    );

    const plan = await planSeed({ projectDir });
    const skippedPaths = new Set(plan.skipped.map((e) => e.path));
    expect(skippedPaths.has('external-sources')).toBe(true);
    expect(skippedPaths.has('external-sources/.ok')).toBe(true);
    expect(skippedPaths.has('external-sources/.ok/frontmatter.yml')).toBe(true);

    // Other folders still planned.
    const createdPaths = new Set(plan.created.map((e) => e.path));
    expect(createdPaths.has('research')).toBe(true);
    expect(createdPaths.has('articles')).toBe(true);
  });

  test('rootDir scopes the scaffold under a subfolder', async () => {
    const plan = await planSeed({ projectDir, rootDir: 'brain' });
    const createdPaths = new Set(plan.created.map((e) => e.path));

    expect(createdPaths.has('brain')).toBe(true);
    for (const folder of STARTER_FOLDERS) {
      expect(createdPaths.has(`brain/${folder.path}`)).toBe(true);
      expect(createdPaths.has(`brain/${folder.path}/.ok/frontmatter.yml`)).toBe(true);
      expect(
        createdPaths.has(`brain/${folder.path}/.ok/templates/${folder.starterTemplate}.md`),
      ).toBe(true);
    }
    expect(createdPaths.has('brain/log.md')).toBe(true);
  });

  test('rootDir rejects absolute paths', async () => {
    await expect(planSeed({ projectDir, rootDir: '/etc/evil' })).rejects.toThrow(SeedRootDirError);
  });

  test('rootDir rejects path traversal', async () => {
    await expect(planSeed({ projectDir, rootDir: '../escape' })).rejects.toThrow(SeedRootDirError);
  });

  // OK never creates an agent home, so `installPackSkill` declines outright in a
  // project that adopted none. A plan reporting the skills pending there
  // promises work apply refuses on every run — the seed then claims it did
  // something forever while doing nothing.
  test('no agent folder: pack skills are not pending, and the plan says why', async () => {
    const plan = await planSeed({ projectDir, packId: 'plain-notes' });
    expect(plan.packSkills?.length).toBeGreaterThan(0);
    expect(plan.packSkills?.some((s) => s.pending)).toBe(false);
    expect(plan.packSkillHomeRefusal).toBe('no-agent-folder');
  });

  test('with an adopted agent folder, an absent pack skill is pending', async () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    const plan = await planSeed({ projectDir, packId: 'plain-notes' });
    expect(plan.packSkills?.some((s) => s.pending)).toBe(true);
    expect(plan.packSkillHomeRefusal).toBeUndefined();
  });

  // The OTHER refusal: an agent folder DOES exist, but it symlinks out of the
  // project, so authoring through it would write outside the repo. Kept
  // distinct from `no-agent-folder` because the two need different user
  // guidance (replace the symlink vs. create a folder), so the plan must
  // report which one it is rather than collapse both into "no home".
  test('an agent folder symlinked outside the project refuses with home-escapes-project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'seed-outside-'));
    try {
      // `.claude` resolves outside the project and its `skills` root exists —
      // the shape `resolveDefaultSkillHomeRel` picks and the escape guard then
      // refuses.
      symlinkSync(outside, join(projectDir, '.claude'));
      mkdirSync(join(outside, 'skills'), { recursive: true });

      const plan = await planSeed({ projectDir, packId: 'plain-notes' });

      expect(plan.packSkillHomeRefusal).toBe('home-escapes-project');
      expect(plan.packSkills?.some((s) => s.pending)).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('planSeed — codebase-wiki nested paths', () => {
  let projectDir: string;
  const WIKI_PACK = STARTER_PACKS['codebase-wiki'];

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-plan-wiki-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('plans nested folder + .ok/frontmatter.yml + template entries with slash-bearing template ids', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const byPath = new Map(plan.created.map((e) => [e.path, e]));

    for (const folder of WIKI_PACK.folders) {
      expect(byPath.has(folder.path)).toBe(true); // e.g. wiki/architecture
      expect(byPath.get(`${folder.path}/.ok/frontmatter.yml`)?.template).toBe(
        `${folder.path}/.ok/frontmatter.yml`,
      );
      expect(
        byPath.get(`${folder.path}/.ok/templates/${folder.starterTemplate}.md`)?.template,
      ).toBe(`${folder.path}/.ok/templates/${folder.starterTemplate}.md`);
    }
  });

  test('plans wiki/-prefixed rootFiles at their nested paths', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const createdPaths = new Set(plan.created.map((e) => e.path));
    expect(createdPaths.has('wiki/OVERVIEW.md')).toBe(true);
    expect(createdPaths.has('wiki/log.md')).toBe(true);
  });

  // Existing installs are never renamed, so the planner has to recognize a
  // pack skill sitting under its OLD name. Two ways this goes wrong: reporting
  // it pending (dry-run promises an install apply then declines), or classifying
  // it by the shipped name — whose lock key does not exist — and calling the
  // user's own skill a name collision.
  test('a pack skill installed under its old name reads as present, not pending, not conflicted', async () => {
    const oldName = 'open-knowledge-pack-plain-notes';
    const skillDir = join(projectDir, '.claude', 'skills', oldName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${oldName}\ndescription: "Plain notes."\nmetadata:\n  pack: "plain-notes"\n---\n\nBody.\n`,
      'utf-8',
    );

    const plan = await planSeed({ projectDir, packId: 'plain-notes' });

    const orientation = plan.packSkills?.find((s) => s.name === 'note-taking');
    expect(orientation).toBeDefined();
    expect(orientation?.pending).toBe(false);
    expect(orientation?.conflict).toBeUndefined();
  });

  // The update path rewrites frontmatter as {name, description}, dropping
  // `metadata.pack`. After one Update the ONLY remaining proof that a legacy
  // install is ours is its lock entry — which is keyed by the OLD name. Probe
  // the lock with the shipped name and it always misses, so a skill we authored
  // starts reporting as the user's own name collision, for a skill that exists
  // nowhere on disk.
  test('an updated legacy install (no metadata.pack) is still ours, via its old lock key', async () => {
    const oldName = 'open-knowledge-pack-plain-notes';
    const skillDir = join(projectDir, '.claude', 'skills', oldName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${oldName}\ndescription: "Plain notes."\n---\n\nBody.\n`,
      'utf-8',
    );
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(
      join(projectDir, '.ok', 'skills-lock.json'),
      `${JSON.stringify(
        {
          schema: 1,
          skills: {
            [oldName]: {
              source: 'inkeep/open-knowledge-skills',
              skill: oldName,
              contentHash: 'h',
              importedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    const plan = await planSeed({ projectDir, packId: 'plain-notes' });

    const orientation = plan.packSkills?.find((s) => s.name === 'note-taking');
    expect(orientation?.pending).toBe(false);
    expect(orientation?.conflict).toBeUndefined();
  });
});
