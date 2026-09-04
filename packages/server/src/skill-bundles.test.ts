import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSkillRefs, RESERVED_PROJECT_SKILL_NAME } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  BUNDLE_IDS,
  BUNDLE_SCOPE,
  BUNDLE_SKILL_NAME,
  bundleSkillMdPath,
  ONBOARDING_BUNDLE_IDS,
  USER_GLOBAL_BUNDLE_IDS,
} from './skill-bundles.ts';

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

  test("core's RESERVED_PROJECT_SKILL_NAME stays in lock-step with BUNDLE_SKILL_NAME.project", () => {
    expect(RESERVED_PROJECT_SKILL_NAME).toBe(BUNDLE_SKILL_NAME.project);
  });

  test('user-global bundles contain no skill refs', () => {
    for (const id of USER_GLOBAL_BUNDLE_IDS) {
      const raw = readFileSync(join(REPO_ROOT, bundleSkillMdPath(id)), 'utf-8');
      const refs = extractSkillRefs(raw);
      expect({ id, refs }).toEqual({ id, refs: [] });
    }
  });

  test('onboarding offers a non-empty subset of the user-global bundles', () => {
    expect(ONBOARDING_BUNDLE_IDS.length).toBeGreaterThan(0);
    for (const id of ONBOARDING_BUNDLE_IDS) {
      expect(USER_GLOBAL_BUNDLE_IDS).toContain(id);
      expect(BUNDLE_SCOPE[id]).toBe('user');
    }
  });

  test('write-skill is deliberately NOT an onboarding bundle', () => {
    expect(USER_GLOBAL_BUNDLE_IDS).toContain('write-skill');
    expect(ONBOARDING_BUNDLE_IDS as readonly string[]).not.toContain('write-skill');
  });

  test('write-skill description is within the skill contract (≤1024, no XML tags)', () => {
    const raw = readFileSync(join(REPO_ROOT, bundleSkillMdPath('write-skill')), 'utf-8');
    const desc = /description:\s*"([\s\S]*?)"\n/.exec(raw)?.[1] ?? '';
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(1024);
    expect(/<\/?[A-Za-z][^>]*>/.test(desc)).toBe(false);
  });
});
