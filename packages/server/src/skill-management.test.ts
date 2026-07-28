import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  isProjectSkillManaged,
  readSkillManagement,
  skillManagementPath,
  writeSkillManagement,
} from './skill-management.ts';

let root: string;
const noEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-skill-mgmt-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('skill-management marker', () => {
  test('path is <project>/.ok/local/skill-management.json', () => {
    expect(skillManagementPath(root)).toBe(join(root, '.ok', 'local', 'skill-management.json'));
  });

  test('absent marker reads as null and is not managed by default', () => {
    expect(readSkillManagement(root)).toBeNull();
    expect(isProjectSkillManaged(root, noEnv)).toBe(false);
  });

  test('write → read round-trip records the decision + stamps decidedAt', async () => {
    await writeSkillManagement(root, { manageEditorSkills: true, surface: 'cli' });
    const read = readSkillManagement(root);
    expect(read?.manageEditorSkills).toBe(true);
    expect(read?.surface).toBe('cli');
    expect(read?.version).toBe(1);
    expect(typeof read?.decidedAt).toBe('string');
    expect(isProjectSkillManaged(root, noEnv)).toBe(true);
  });

  test('write false → not managed', async () => {
    await writeSkillManagement(root, { manageEditorSkills: false, surface: 'cli' });
    expect(isProjectSkillManaged(root, noEnv)).toBe(false);
  });

  test('marker lives under .ok/local (gitignored per-machine state)', async () => {
    await writeSkillManagement(root, { manageEditorSkills: true });
    expect(existsSync(join(root, '.ok', 'local', 'skill-management.json'))).toBe(true);
  });

  test('corrupt marker fails soft → null / not managed', () => {
    const path = skillManagementPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    expect(readSkillManagement(root)).toBeNull();
    expect(isProjectSkillManaged(root, noEnv)).toBe(false);
  });

  test('malformed shape (no boolean) fails soft → null', () => {
    const path = skillManagementPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, manageEditorSkills: 'yes' }));
    expect(readSkillManagement(root)).toBeNull();
  });

  describe('isProjectSkillManaged env precedence', () => {
    test('OK_RECLAIM_DISABLE=1 forces off even when the marker says on', async () => {
      await writeSkillManagement(root, { manageEditorSkills: true });
      expect(isProjectSkillManaged(root, { OK_RECLAIM_DISABLE: '1', OK_SKILL_MANAGE: '1' })).toBe(
        false,
      );
    });

    test('OK_SKILL_MANAGE=1 forces on with no marker; =0 forces off over an on marker', async () => {
      expect(isProjectSkillManaged(root, { OK_SKILL_MANAGE: '1' })).toBe(true);
      await writeSkillManagement(root, { manageEditorSkills: true });
      expect(isProjectSkillManaged(root, { OK_SKILL_MANAGE: '0' })).toBe(false);
    });

    test('falls through to the marker when no env override is set', async () => {
      await writeSkillManagement(root, { manageEditorSkills: true });
      expect(isProjectSkillManaged(root, noEnv)).toBe(true);
    });

    test('env override does not write the marker to disk', () => {
      isProjectSkillManaged(root, { OK_SKILL_MANAGE: '1' });
      expect(existsSync(skillManagementPath(root))).toBe(false);
    });
  });
});
