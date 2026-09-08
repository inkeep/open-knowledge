import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EDITOR_TARGETS } from '../commands/editors.ts';
import {
  hubReadersAmong,
  writeProjectSkill,
  writeProjectSkillToHub,
} from './write-project-skill.ts';

describe('the built-in project skill reaches the .agents hub', () => {
  let home: string;
  let project: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-hub-home-'));
    project = mkdtempSync(join(tmpdir(), 'ok-hub-project-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const hubSkill = () => join(project, '.agents', 'skills', 'open-knowledge', 'SKILL.md');

  test('the per-editor writer cannot serve a hub reader — the gap this closes', () => {
    expect(writeProjectSkill(EDITOR_TARGETS['lm-studio'], project, { home }).action).toBe(
      'skipped-unsupported',
    );
  });

  test('writes into the hub when the user selected a hub reader', () => {
    const result = writeProjectSkillToHub(project, ['lm-studio']);

    expect(result?.action).toBe('written');
    expect(existsSync(hubSkill())).toBe(true);
  });

  test('writes nothing when no selected editor reads the hub', () => {
    expect(writeProjectSkillToHub(project, ['claude', 'cursor'])).toBeNull();
    expect(existsSync(hubSkill())).toBe(false);
  });

  test('an empty selection writes nothing, like every other writer here', () => {
    expect(writeProjectSkillToHub(project, [])).toBeNull();
    expect(existsSync(hubSkill())).toBe(false);
  });

  test('only project-scope hub readers count', () => {
    expect(hubReadersAmong(['lm-studio'])).toEqual(['lm-studio']);
    expect(hubReadersAmong(['openclaw', 'claude'])).toEqual([]);
  });
});
