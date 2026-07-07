import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installedSkillsPath,
  readInstalledSkills,
  recordSkillInstall,
  removeSkillInstall,
} from './installed-skills-marker.ts';

let projectDir: string;

const entry = (hosts: string[]) => ({
  hosts,
  contentHash: 'abc123',
  scope: 'project' as const,
  scripts: false,
  installedAt: '2026-06-05T00:00:00.000Z',
});

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-marker-'));
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('installed-skills marker', () => {
  test('absent marker reads as empty (fail-soft)', () => {
    const state = readInstalledSkills(projectDir);
    expect(state.schema).toBe(1);
    expect(state.skills).toEqual({});
  });

  test('record then read round-trips an entry under .ok/local/', async () => {
    await recordSkillInstall(projectDir, 'trip-log', entry(['claude', 'cursor']));
    expect(installedSkillsPath(projectDir)).toContain('/.ok/local/installed-skills.json');
    const state = readInstalledSkills(projectDir);
    expect(state.skills['trip-log']?.hosts).toEqual(['claude', 'cursor']);
    expect(state.skills['trip-log']?.scope).toBe('project');
  });

  test('record is additive across skills and overwrites same name', async () => {
    await recordSkillInstall(projectDir, 'a', entry(['claude']));
    await recordSkillInstall(projectDir, 'b', entry(['cursor']));
    await recordSkillInstall(projectDir, 'a', entry(['claude', 'codex']));
    const state = readInstalledSkills(projectDir);
    expect(Object.keys(state.skills).sort()).toEqual(['a', 'b']);
    expect(state.skills.a?.hosts).toEqual(['claude', 'codex']);
  });

  test('remove returns the removed entry and drops it; no-op returns null', async () => {
    await recordSkillInstall(projectDir, 'gone', entry(['claude']));
    const removed = await removeSkillInstall(projectDir, 'gone');
    expect(removed?.hosts).toEqual(['claude']);
    expect(readInstalledSkills(projectDir).skills.gone).toBeUndefined();

    const noop = await removeSkillInstall(projectDir, 'never');
    expect(noop).toBeNull();
  });

  test('corrupt marker JSON reads as empty (fail-soft), never throws', async () => {
    // A prior record creates `.ok/local/`; then clobber the file with garbage.
    await recordSkillInstall(projectDir, 'seed', entry(['claude']));
    writeFileSync(installedSkillsPath(projectDir), '{ not valid json', 'utf-8');
    const state = readInstalledSkills(projectDir);
    expect(state.skills).toEqual({});
  });
});
