import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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

const seedMarker = (contents: string): void => {
  mkdirSync(dirname(installedSkillsPath(projectDir)), { recursive: true });
  writeFileSync(installedSkillsPath(projectDir), contents, 'utf-8');
};

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
    await recordSkillInstall(projectDir, 'seed', entry(['claude']));
    writeFileSync(installedSkillsPath(projectDir), '{ not valid json', 'utf-8');
    const state = readInstalledSkills(projectDir);
    expect(state.skills).toEqual({});
  });

  test('recording over a corrupt marker refuses and leaves the file byte-identical', async () => {
    await recordSkillInstall(projectDir, 'seed', entry(['claude']));
    const truncated = '{"schema":1,"skills":{"seed":{"hosts":["cla';
    writeFileSync(installedSkillsPath(projectDir), truncated, 'utf-8');

    await expect(recordSkillInstall(projectDir, 'next', entry(['cursor']))).rejects.toThrow(
      /Refusing to rewrite/,
    );
    expect(readFileSync(installedSkillsPath(projectDir), 'utf-8')).toBe(truncated);
  });

  test('recording over a marker version this server cannot read keeps every sibling install', async () => {
    const future = `${JSON.stringify(
      { schema: 2, skills: { seed: { hosts: ['claude'], scope: 'project' } } },
      null,
      2,
    )}\n`;
    seedMarker(future);

    await expect(recordSkillInstall(projectDir, 'next', entry(['cursor']))).rejects.toThrow(
      /Refusing to rewrite/,
    );
    expect(readFileSync(installedSkillsPath(projectDir), 'utf-8')).toBe(future);
  });

  test('removing over a corrupt marker refuses rather than reporting nothing to remove', async () => {
    const truncated = '{"schema":1,"skills":{"gone":{"hosts":["cla';
    seedMarker(truncated);

    await expect(removeSkillInstall(projectDir, 'gone')).rejects.toThrow(/Refusing to rewrite/);
    expect(readFileSync(installedSkillsPath(projectDir), 'utf-8')).toBe(truncated);
  });

  test('a marker that cannot be opened at all refuses with the errno, not a parse verdict', async () => {
    mkdirSync(installedSkillsPath(projectDir), { recursive: true });

    await expect(recordSkillInstall(projectDir, 'next', entry(['cursor']))).rejects.toThrow(
      /Refusing to rewrite .*: it could not be read \(EISDIR\)/,
    );
  });

  test('an entry field this server does not model survives a sibling record', async () => {
    seedMarker(
      JSON.stringify({
        schema: 1,
        skills: { seed: { ...entry(['claude']), futureField: 'keep-me' } },
      }),
    );

    await recordSkillInstall(projectDir, 'next', entry(['cursor']));

    const state = JSON.parse(readFileSync(installedSkillsPath(projectDir), 'utf-8'));
    expect(state.skills.seed.futureField).toBe('keep-me');
    expect(state.skills.next.hosts).toEqual(['cursor']);
  });
});
