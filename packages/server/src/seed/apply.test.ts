import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeed } from './apply.ts';
import { planSeed } from './plan.ts';
import { STARTER_PACKS } from './starter.ts';

const KNOWLEDGE_BASE_PACK = STARTER_PACKS['knowledge-base'];
const STARTER_FOLDERS = KNOWLEDGE_BASE_PACK.folders;
const STARTER_TEMPLATES = KNOWLEDGE_BASE_PACK.templates;
const LOG_MD_TEMPLATE = KNOWLEDGE_BASE_PACK.rootFiles?.['log.md'];
if (!LOG_MD_TEMPLATE) throw new Error('knowledge-base pack is missing log.md');

describe('applySeed — nested .ok/ era', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-apply-'));
    // planSeed's gate requires `.ok/config.yml`. Seed it so apply tests can
    // exercise the post-gate plan/apply flow.
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('writes every starter folder + nested .ok/frontmatter.yml + starter template', async () => {
    const plan = await planSeed({ projectDir });
    const result = await applySeed(plan, { projectDir });

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(plan.created.length);

    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(projectDir, folder.path))).toBe(true);
      expect(existsSync(join(projectDir, folder.path, '.ok'))).toBe(true);
      expect(existsSync(join(projectDir, folder.path, '.ok', 'frontmatter.yml'))).toBe(true);
      expect(existsSync(join(projectDir, folder.path, '.ok', 'templates'))).toBe(true);
      expect(
        existsSync(
          join(projectDir, folder.path, '.ok', 'templates', `${folder.starterTemplate}.md`),
        ),
      ).toBe(true);
    }
    expect(existsSync(join(projectDir, 'log.md'))).toBe(true);
  });

  test('frontmatter.yml carries the folder defaults verbatim from STARTER_FOLDERS', async () => {
    const plan = await planSeed({ projectDir });
    await applySeed(plan, { projectDir });

    for (const folder of STARTER_FOLDERS) {
      const fmContent = readFileSync(
        join(projectDir, folder.path, '.ok', 'frontmatter.yml'),
        'utf-8',
      );
      // Title + description quoted-or-not depending on content; check substring.
      expect(fmContent).toContain(folder.title);
      expect(fmContent).toContain(folder.description.slice(0, 30));
      for (const tag of folder.tags) {
        expect(fmContent).toContain(`- ${tag}`);
      }
    }
  });

  test('starter template files contain the registered STARTER_TEMPLATES body verbatim', async () => {
    const plan = await planSeed({ projectDir });
    await applySeed(plan, { projectDir });

    for (const folder of STARTER_FOLDERS) {
      const tplContent = readFileSync(
        join(projectDir, folder.path, '.ok', 'templates', `${folder.starterTemplate}.md`),
        'utf-8',
      );
      expect(tplContent).toBe(STARTER_TEMPLATES[folder.starterTemplate]);
    }
  });

  test('log.md gets the LOG_MD_TEMPLATE content verbatim', async () => {
    const plan = await planSeed({ projectDir });
    await applySeed(plan, { projectDir });
    const logContent = readFileSync(join(projectDir, 'log.md'), 'utf-8');
    expect(logContent).toBe(LOG_MD_TEMPLATE);
  });

  test('rerunning seed is idempotent — existing files are skipped, no errors', async () => {
    const firstPlan = await planSeed({ projectDir });
    const firstResult = await applySeed(firstPlan, { projectDir });
    expect(firstResult.errors).toEqual([]);

    const secondPlan = await planSeed({ projectDir });
    const secondResult = await applySeed(secondPlan, { projectDir });
    expect(secondResult.errors).toEqual([]);
    // Second pass should have nothing left to create.
    expect(secondPlan.created).toEqual([]);
    expect(secondResult.applied).toBe(0);
  });

  test('user-edited frontmatter.yml is preserved across reseed', async () => {
    // First seed.
    const plan1 = await planSeed({ projectDir });
    await applySeed(plan1, { projectDir });

    // User edits one of the frontmatter files.
    const fmPath = join(projectDir, 'external-sources', '.ok', 'frontmatter.yml');
    const userEdit =
      'title: My Custom External Sources\ndescription: edited by user\ntags:\n  - mine\n';
    writeFileSync(fmPath, userEdit, 'utf-8');

    // Re-seed.
    const plan2 = await planSeed({ projectDir });
    await applySeed(plan2, { projectDir });

    // User content survives.
    expect(readFileSync(fmPath, 'utf-8')).toBe(userEdit);
  });

  test('rootDir scopes apply under a subfolder', async () => {
    const plan = await planSeed({ projectDir, rootDir: 'brain' });
    const result = await applySeed(plan, { projectDir });

    expect(result.errors).toEqual([]);
    for (const folder of STARTER_FOLDERS) {
      expect(existsSync(join(projectDir, 'brain', folder.path, '.ok', 'frontmatter.yml'))).toBe(
        true,
      );
      expect(
        existsSync(
          join(
            projectDir,
            'brain',
            folder.path,
            '.ok',
            'templates',
            `${folder.starterTemplate}.md`,
          ),
        ),
      ).toBe(true);
    }
    expect(existsSync(join(projectDir, 'brain', 'log.md'))).toBe(true);
  });

  test('reports an error for unknown template ids without crashing', async () => {
    // Hand-craft a plan with an entry that points at a template id we don't
    // ship — apply should record an error rather than write empty content.
    const result = await applySeed(
      {
        created: [
          {
            path: 'phantom/.ok/templates/unknown.md',
            kind: 'file',
            template: 'phantom/.ok/templates/unknown.md',
          },
        ],
        skipped: [],
        warnings: [],
      },
      { projectDir },
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain('No content template registered');
  });
});

describe('applySeed — codebase-wiki nested folder paths + wiki/-prefixed rootFiles', () => {
  // Regression guard for the `resolveFileContent` resolver: the `codebase-wiki`
  // pack is the only one whose folder paths nest (`wiki/architecture`) and whose
  // rootFiles keys carry a folder prefix (`wiki/OVERVIEW.md`). A resolver that
  // only matched single-segment folder ids (or required bare-filename rootFiles)
  // would record "No content template registered" errors and write nothing.
  let projectDir: string;
  const WIKI_PACK = STARTER_PACKS['codebase-wiki'];

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'seed-apply-wiki-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  test('writes every nested wiki/<section> with .ok/frontmatter.yml + template and no errors', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const result = await applySeed(plan, { projectDir, packId: 'codebase-wiki' });

    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(plan.created.length);

    for (const folder of WIKI_PACK.folders) {
      // folder.path is e.g. `wiki/architecture` — the nested case.
      expect(existsSync(join(projectDir, folder.path, '.ok', 'frontmatter.yml'))).toBe(true);
      expect(
        existsSync(
          join(projectDir, folder.path, '.ok', 'templates', `${folder.starterTemplate}.md`),
        ),
      ).toBe(true);
    }
  });

  test('nested frontmatter.yml resolves to the folder defaults (resolver tolerates the slash)', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    await applySeed(plan, { projectDir, packId: 'codebase-wiki' });

    for (const folder of WIKI_PACK.folders) {
      const fm = readFileSync(join(projectDir, folder.path, '.ok', 'frontmatter.yml'), 'utf-8');
      expect(fm).toContain(folder.title);
      for (const tag of folder.tags) expect(fm).toContain(`- ${tag}`);
    }
  });

  test('template bodies resolve verbatim for nested folder paths', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    await applySeed(plan, { projectDir, packId: 'codebase-wiki' });

    for (const folder of WIKI_PACK.folders) {
      const tpl = readFileSync(
        join(projectDir, folder.path, '.ok', 'templates', `${folder.starterTemplate}.md`),
        'utf-8',
      );
      expect(tpl).toBe(WIKI_PACK.templates[folder.starterTemplate]);
    }
  });

  test('wiki/-prefixed rootFiles land at wiki/OVERVIEW.md + wiki/log.md with verbatim content', async () => {
    const plan = await planSeed({ projectDir, packId: 'codebase-wiki' });
    const result = await applySeed(plan, { projectDir, packId: 'codebase-wiki' });

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(projectDir, 'wiki', 'OVERVIEW.md'), 'utf-8')).toBe(
      WIKI_PACK.rootFiles?.['wiki/OVERVIEW.md'],
    );
    expect(readFileSync(join(projectDir, 'wiki', 'log.md'), 'utf-8')).toBe(
      WIKI_PACK.rootFiles?.['wiki/log.md'],
    );
  });
});
