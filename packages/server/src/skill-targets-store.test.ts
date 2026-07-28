import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readSkillTargets, skillTargetsPath, writeSkillTargets } from './skill-targets-store.ts';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-targets-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('skill-targets store', () => {
  test('absent store reads null (→ caller falls back to detection)', () => {
    expect(readSkillTargets(projectDir)).toBeNull();
  });

  test('write then read round-trips, committed at .ok/ root (not local/)', async () => {
    await writeSkillTargets(projectDir, ['claude', 'cursor']);
    expect(skillTargetsPath(projectDir)).toContain('/.ok/skill-targets.json');
    expect(skillTargetsPath(projectDir)).not.toContain('/local/');
    expect(readSkillTargets(projectDir)).toEqual(['claude', 'cursor']);
  });

  test('write de-dupes and an empty set is distinct from absent', async () => {
    await writeSkillTargets(projectDir, ['claude', 'claude', 'codex']);
    expect(readSkillTargets(projectDir)).toEqual(['claude', 'codex']);
    await writeSkillTargets(projectDir, []);
    expect(readSkillTargets(projectDir)).toEqual([]); // empty != null
  });

  test('corrupt store reads null (fail-soft)', async () => {
    await writeSkillTargets(projectDir, ['claude']);
    writeFileSync(skillTargetsPath(projectDir), '{ not json', 'utf-8');
    expect(readSkillTargets(projectDir)).toBeNull();
  });
});
