import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EDITOR_TARGETS } from '../commands/editors.ts';
import { removeProjectSkill } from './write-project-skill.ts';

const CLAUDE = EDITOR_TARGETS.claude;

describe('removeProjectSkill', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-remove-project-skill-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create the managed skill dir with its SKILL.md ownership marker. */
  function seedSkill(): string {
    const skillPath = CLAUDE.projectSkillPath?.(dir);
    if (!skillPath) throw new Error('claude has no projectSkillPath');
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, '# open-knowledge\n');
    return skillPath;
  }

  test('removes the managed skill directory whole', () => {
    const skillPath = seedSkill();
    const skillDir = dirname(skillPath);
    // A sibling file inside the OK-owned dir goes too — the dir is OK's namespace.
    writeFileSync(join(skillDir, 'reference.md'), 'x');
    expect(existsSync(skillPath)).toBe(true);

    const result = removeProjectSkill(CLAUDE, dir);

    expect(result.action).toBe('removed');
    expect(result.path).toBe(skillPath);
    expect(existsSync(skillDir)).toBe(false);
  });

  test('is idempotent — a second removal reports not-present', () => {
    seedSkill();
    expect(removeProjectSkill(CLAUDE, dir).action).toBe('removed');
    expect(removeProjectSkill(CLAUDE, dir).action).toBe('not-present');
  });

  test('leaves a directory without the SKILL.md ownership marker untouched', () => {
    const skillPath = CLAUDE.projectSkillPath?.(dir);
    if (!skillPath) throw new Error('claude has no projectSkillPath');
    const skillDir = dirname(skillPath);
    mkdirSync(skillDir, { recursive: true });
    // A directory squatting the name but with no managed SKILL.md is not ours.
    writeFileSync(join(skillDir, 'their-notes.md'), 'not ours');

    const result = removeProjectSkill(CLAUDE, dir);

    expect(result.action).toBe('not-present');
    expect(existsSync(skillDir)).toBe(true);
    expect(existsSync(join(skillDir, 'their-notes.md'))).toBe(true);
  });

  test('refuses to remove through a symlinked ancestor escaping the project', () => {
    // `.claude` is a symlink to an outside dir; the skill "exists" through it,
    // but removal must refuse rather than route rmSync outside the project.
    const outside = mkdtempSync(join(tmpdir(), 'ok-remove-project-skill-outside-'));
    try {
      const managed = join(outside, 'skills', 'open-knowledge');
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, 'SKILL.md'), '# open-knowledge\n');
      symlinkSync(outside, join(dir, '.claude'), 'dir');

      const result = removeProjectSkill(CLAUDE, dir);

      expect(result.action).toBe('failed');
      // The outside content is preserved — nothing was removed through the link.
      expect(existsSync(join(managed, 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('removes a skill dir that is itself a symlink, leaving the link target intact', () => {
    // A projection-style install: the managed dir is a symlink into `.ok/skills`.
    const skillPath = CLAUDE.projectSkillPath?.(dir);
    if (!skillPath) throw new Error('claude has no projectSkillPath');
    const skillDir = dirname(skillPath);
    const source = join(dir, '.ok', 'skills', 'open-knowledge');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# open-knowledge\n');
    mkdirSync(dirname(skillDir), { recursive: true });
    symlinkSync(source, skillDir, 'dir');

    const result = removeProjectSkill(CLAUDE, dir);

    expect(result.action).toBe('removed');
    expect(existsSync(skillDir)).toBe(false);
    // Only the link was removed; the projection source survives.
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true);
  });

  test('reports skipped-unsupported for an editor with no project skill path', () => {
    const noSkill = EDITOR_TARGETS['claude-desktop'];
    expect(noSkill.projectSkillPath).toBeUndefined();
    const result = removeProjectSkill(noSkill, dir);
    expect(result.action).toBe('skipped-unsupported');
    expect(result.path).toBe('');
  });
});
