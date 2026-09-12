import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SkillTargetsGetSuccessSchema } from './schemas/api/tags-search.ts';
import { scanSkillFolderStates, skillFolderStateForWire } from './skill-folder-state.ts';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ok-skill-folder-state-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const roots = [
  { editor: 'claude', root: '.claude/skills' },
  { editor: 'codex', root: '.codex/skills' },
  { editor: 'cursor', root: '.cursor/skills' },
];

describe('scanSkillFolderStates identity', () => {
  test('every state that has a folder carries `real`; `absent` carries none', () => {
    mkdirSync(join(base, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(base, '.codex'), { recursive: true });
    symlinkSync(join(base, '.claude', 'skills'), join(base, '.codex', 'skills'));

    const [claude, codex, cursor] = scanSkillFolderStates(base, roots);
    if (claude?.state === 'absent' || codex?.state === 'absent') throw new Error('setup');
    expect(claude?.real).toBe(codex?.real);
    expect(claude?.target).toBeUndefined();
    expect(codex?.target).toBe('.claude/skills');
    expect(cursor).toEqual({ host: 'cursor', root: '.cursor/skills', state: 'absent' });
  });

  test('roots aliased to different places outside the base do not share a `real`', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ok-elsewhere-'));
    mkdirSync(join(elsewhere, 'a'), { recursive: true });
    mkdirSync(join(elsewhere, 'b'), { recursive: true });
    mkdirSync(join(base, '.codex'), { recursive: true });
    mkdirSync(join(base, '.cursor'), { recursive: true });
    symlinkSync(join(elsewhere, 'a'), join(base, '.codex', 'skills'));
    symlinkSync(join(elsewhere, 'b'), join(base, '.cursor', 'skills'));

    const [, codex, cursor] = scanSkillFolderStates(base, roots);
    if (codex?.state === 'absent' || cursor?.state === 'absent') throw new Error('setup');
    expect(codex?.target).toBeUndefined();
    expect(cursor?.target).toBeUndefined();
    expect(codex?.real).not.toBe(cursor?.real);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('the wire shape', () => {
  test('drops `real`, and the result satisfies the strict folders schema', () => {
    mkdirSync(join(base, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(base, '.codex'), { recursive: true });
    symlinkSync(join(base, '.claude', 'skills'), join(base, '.codex', 'skills'));

    const scanned = scanSkillFolderStates(base, roots);
    for (const state of scanned) {
      expect(skillFolderStateForWire(state)).not.toHaveProperty('real');
    }

    const parsed = SkillTargetsGetSuccessSchema.safeParse({
      targets: [],
      configured: false,
      folders: scanned.map((f) => ({ ...skillFolderStateForWire(f), scope: 'global' as const })),
    });
    expect(parsed.success).toBe(true);

    const leaked = SkillTargetsGetSuccessSchema.safeParse({
      targets: [],
      configured: false,
      folders: scanned.map((f) => ({ ...f, scope: 'global' as const })),
    });
    expect(leaked.success).toBe(false);
  });
});
