import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
