import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createContentFilter, createContentFilterAsync } from './content-filter.ts';

describe('skill-root admission', () => {
  function withFixture<T>(fn: (contentDir: string) => T): T {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-skill-roots-'));
    try {
      mkdirSync(join(projectDir, '.github'), { recursive: true });
      writeFileSync(join(projectDir, '.github', 'CI_RUNBOOK.md'), '# Runbook\n');
      return fn(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }

  test('a non-canonical projection is excluded while the canonical one is admitted', () => {
    withFixture((contentDir) => {
      const filter = createContentFilter({
        projectDir: contentDir,
        contentDir,
        inPlaceSkillDirs: new Set(['.claude/skills/knowledge-base']),
        skillRootPaths: new Set(['.claude/skills', '.github/skills']),
      });
      expect(filter.isExcluded('.claude/skills/knowledge-base/SKILL.md')).toBe(false);
      expect(filter.isExcluded('.github/skills/knowledge-base/SKILL.md')).toBe(true);
    });
  });

  test('a skill canonical in .github is admitted — no root is privileged', () => {
    withFixture((contentDir) => {
      const filter = createContentFilter({
        projectDir: contentDir,
        contentDir,
        inPlaceSkillDirs: new Set(['.github/skills/github-only']),
        skillRootPaths: new Set(['.claude/skills', '.github/skills']),
      });
      expect(filter.isExcluded('.github/skills/github-only/SKILL.md')).toBe(false);
    });
  });

  test('content beside a projection stays indexed — the root path is scoped, not the host dotdir', () => {
    withFixture((contentDir) => {
      const filter = createContentFilter({
        projectDir: contentDir,
        contentDir,
        inPlaceSkillDirs: new Set(['.claude/skills/knowledge-base']),
        skillRootPaths: new Set(['.claude/skills', '.github/skills']),
      });
      expect(filter.isExcluded('.github/CI_RUNBOOK.md')).toBe(false);
    });
  });

  test('feature off (no roots supplied) leaves admission unchanged', () => {
    withFixture((contentDir) => {
      const filter = createContentFilter({ projectDir: contentDir, contentDir });
      expect(filter.isExcluded('.github/CI_RUNBOOK.md')).toBe(false);
    });
  });
});

describe.each([
  ['sync', createContentFilter],
  ['async', createContentFilterAsync],
] as const)('always-skip bound under skill roots (%s factory)', (_name, factory) => {
  const skillRoots = ['.ok/skills/demo', '.claude/skills/demo'];
  const skippedBelow = [
    '.git',
    '.GIT',
    '.Git',
    'node_modules',
    'NODE_MODULES',
    '.ok',
    '.OK',
    '.open-knowledge',
    '.openknowledge',
    '.claude',
    '.cursor',
    '.codex',
    '.agents',
    '.opencode',
    '.pi',
  ];

  async function build(contentDir: string) {
    return factory({
      projectDir: contentDir,
      contentDir,
      inPlaceSkillDirs: new Set(['.claude/skills/demo']),
    });
  }

  test.each(skillRoots)(
    '%s: skill files are admitted, VCS and package dirs are not',
    async (root) => {
      const contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-bound-'));
      try {
        const filter = await build(contentDir);
        expect(filter.isExcluded(`${root}/SKILL.md`)).toBe(false);
        expect(filter.isDirExcluded(root)).toBe(false);
        expect(filter.isDirExcluded(`${root}/scripts`)).toBe(false);
        expect(filter.isExcluded(`${root}/.DS_Store`)).toBe(true);
        expect(filter.isExcluded(`${root}/.ds_store`)).toBe(true);
        expect(filter.isPathIgnored(`${root}/.DS_Store`)).toBe(true);
        expect(filter.isPathIgnored(`${root}/.ds_store`)).toBe(true);
        for (const dir of skippedBelow) {
          expect(`${dir}=${filter.isExcluded(`${root}/${dir}/config.md`)}`).toBe(`${dir}=true`);
          expect(`${dir}=${filter.isPathIgnored(`${root}/${dir}/config.md`)}`).toBe(`${dir}=true`);
          expect(`${dir}=${filter.isDirExcluded(`${root}/${dir}`)}`).toBe(`${dir}=true`);
          expect(`${dir}=${filter.isDirExcluded(`${root}/${dir}/objects`)}`).toBe(`${dir}=true`);
        }
      } finally {
        rmSync(contentDir, { recursive: true, force: true });
      }
    },
  );

  test('case variants of always-skip dirs are withheld at the content root too', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-bound-'));
    try {
      const filter = await build(contentDir);
      for (const path of ['.GIT/config.md', 'NODE_MODULES/p/README.md', '.CLAUDE/notes.md']) {
        expect(`${path}=${filter.isExcluded(path)}`).toBe(`${path}=true`);
        expect(`${path}=${filter.isPathIgnored(path)}`).toBe(`${path}=true`);
      }
      for (const dir of ['.GIT', 'other/.Git', 'NODE_MODULES']) {
        expect(`${dir}=${filter.isDirExcluded(dir)}`).toBe(`${dir}=true`);
      }
      expect(filter.isExcluded('library/notes.md')).toBe(false);
      expect(filter.isExcluded('Library/notes.md')).toBe(true);
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });

  test('.ok artifacts under any case of an always-skip dir are withheld', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-skill-bound-'));
    try {
      const filter = await build(contentDir);
      for (const skip of ['node_modules', 'NODE_MODULES']) {
        const template = `${skip}/p/.ok/templates/x.md`;
        const frontmatter = `${skip}/p/.ok/frontmatter.yml`;
        const synced = filter.isExcluded(frontmatter, { syncScope: { pathBase: 'content' } });
        expect(`${template}=${filter.isExcluded(template)}`).toBe(`${template}=true`);
        expect(`${template}=${filter.isPathIgnored(template)}`).toBe(`${template}=true`);
        expect(`${frontmatter}=${synced}`).toBe(`${frontmatter}=true`);
        for (const dir of [`${skip}/p/.ok`, `${skip}/p/.ok/templates`]) {
          expect(`${dir}=${filter.isDirExcluded(dir)}`).toBe(`${dir}=true`);
        }
      }
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
