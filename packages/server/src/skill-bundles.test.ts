import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_IDS, BUNDLE_SKILL_NAME, bundleSkillMdPath } from './skill-bundles.ts';

// Repo root = three levels up from this file (packages/server/src → root).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('skill-bundles (single source of truth)', () => {
  test('declares the three shipped bundles', () => {
    expect([...BUNDLE_IDS].sort()).toEqual(['discovery', 'project', 'write-skill']);
  });

  test('bundleSkillMdPath derives from the id (= source dir name)', () => {
    expect(bundleSkillMdPath('write-skill')).toBe(
      'packages/server/assets/skills/write-skill/SKILL.md',
    );
  });

  test('every bundle has a SKILL.md on disk whose frontmatter name matches', () => {
    for (const id of BUNDLE_IDS) {
      const abs = join(REPO_ROOT, bundleSkillMdPath(id));
      expect(existsSync(abs)).toBe(true);
      const raw = readFileSync(abs, 'utf-8');
      const nameLine = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim();
      expect(nameLine).toBe(BUNDLE_SKILL_NAME[id]);
    }
  });

  test('write-skill description is within the skill contract (≤1024, no XML tags)', () => {
    const raw = readFileSync(join(REPO_ROOT, bundleSkillMdPath('write-skill')), 'utf-8');
    const desc = /description:\s*"([\s\S]*?)"\n/.exec(raw)?.[1] ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(/<\/?[A-Za-z][^>]*>/.test(desc)).toBe(false);
  });
});
