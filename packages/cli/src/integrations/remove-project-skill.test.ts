import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EDITOR_TARGETS } from '../commands/editors.ts';
import { removeProjectSkill } from './write-project-skill.ts';

const CLAUDE = EDITOR_TARGETS.claude;
const CURSOR = EDITOR_TARGETS.cursor;

describe('removeProjectSkill', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-remove-project-skill-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

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
    writeFileSync(join(skillDir, 'their-notes.md'), 'not ours');

    const result = removeProjectSkill(CLAUDE, dir);

    expect(result.action).toBe('not-present');
    expect(existsSync(skillDir)).toBe(true);
    expect(existsSync(join(skillDir, 'their-notes.md'))).toBe(true);
  });

  test('refuses to remove through a symlinked ancestor escaping the project', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ok-remove-project-skill-outside-'));
    try {
      const managed = join(outside, 'skills', 'open-knowledge');
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, 'SKILL.md'), '# open-knowledge\n');
      symlinkSync(outside, join(dir, '.claude'), 'dir');

      const result = removeProjectSkill(CLAUDE, dir);

      expect(result.action).toBe('failed');
      expect(existsSync(join(managed, 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('removes a skill dir that is itself a symlink, leaving the link target intact', () => {
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
    expect(existsSync(join(source, 'SKILL.md'))).toBe(true);
  });

  test('reports skipped-unsupported for an editor with no project skill path', () => {
    const noSkill = EDITOR_TARGETS['claude-desktop'];
    expect(noSkill.projectSkillPath).toBeUndefined();
    const result = removeProjectSkill(noSkill, dir);
    expect(result.action).toBe('skipped-unsupported');
    expect(result.path).toBe('');
  });

  describe('a skills root shared with another editor', () => {
    function seedSharedRoot(): string {
      const claudeSkill = CLAUDE.projectSkillPath?.(dir);
      if (!claudeSkill) throw new Error('claude has no projectSkillPath');
      mkdirSync(dirname(claudeSkill), { recursive: true });
      writeFileSync(claudeSkill, '# open-knowledge\n');
      mkdirSync(join(dir, '.cursor'), { recursive: true });
      symlinkSync(join(dir, '.claude', 'skills'), join(dir, '.cursor', 'skills'), 'dir');
      return claudeSkill;
    }

    test('removes through the link, which takes the shared bundle with it', () => {
      const claudeSkill = seedSharedRoot();

      const result = removeProjectSkill(CURSOR, dir);

      expect(result.action).toBe('removed');
      expect(existsSync(claudeSkill)).toBe(false);
    });

    test('removes from either side — sharing is not directional', () => {
      const claudeSkill = seedSharedRoot();

      const result = removeProjectSkill(CLAUDE, dir);

      expect(result.action).toBe('removed');
      expect(existsSync(claudeSkill)).toBe(false);
    });

    test('removes through an alias to the vendor-neutral hub', () => {
      const hub = join(dir, '.agents', 'skills', 'open-knowledge');
      mkdirSync(hub, { recursive: true });
      writeFileSync(join(hub, 'SKILL.md'), '# open-knowledge\n');
      mkdirSync(join(dir, '.cursor'), { recursive: true });
      symlinkSync(join(dir, '.agents', 'skills'), join(dir, '.cursor', 'skills'), 'dir');

      const result = removeProjectSkill(CURSOR, dir);

      expect(result.action).toBe('removed');
      expect(existsSync(hub)).toBe(false);
    });

    test('still removes through an alias nothing else reads', () => {
      const own = join(dir, '.vendor', 'skills', 'open-knowledge');
      mkdirSync(own, { recursive: true });
      writeFileSync(join(own, 'SKILL.md'), '# open-knowledge\n');
      mkdirSync(join(dir, '.cursor'), { recursive: true });
      symlinkSync(join(dir, '.vendor', 'skills'), join(dir, '.cursor', 'skills'), 'dir');

      const result = removeProjectSkill(CURSOR, dir);

      expect(result.action).toBe('removed');
      expect(existsSync(own)).toBe(false);
    });

    test('a dangling root is not sharing anything', () => {
      mkdirSync(join(dir, '.cursor'), { recursive: true });
      symlinkSync(join(dir, 'gone'), join(dir, '.cursor', 'skills'), 'dir');

      expect(removeProjectSkill(CURSOR, dir).action).toBe('not-present');
    });
  });
});
