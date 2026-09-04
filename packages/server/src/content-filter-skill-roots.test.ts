import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createContentFilter } from './content-filter.ts';

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
