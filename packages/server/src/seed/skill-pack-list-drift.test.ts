import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { STARTER_PACK_IDS } from './starter.ts';

const SKILL_DIR = join(import.meta.dir, '../../assets/skills/project');
const PACK_BULLET_RE = /^- `([a-z][a-z0-9-]+)` —/gm;

function readSkillBundle(): string {
  const parts = [readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')];
  const refsDir = join(SKILL_DIR, 'references');
  if (existsSync(refsDir)) {
    for (const name of readdirSync(refsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      parts.push(readFileSync(join(refsDir, name), 'utf-8'));
    }
  }
  return parts.join('\n');
}

describe('project SKILL.md starter-pack awareness list', () => {
  test('lists exactly the packs in STARTER_PACK_IDS (drift guard)', () => {
    const skill = readSkillBundle();
    const listed = [...skill.matchAll(PACK_BULLET_RE)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed)).toEqual(new Set(STARTER_PACK_IDS));
  });

  test('points the agent at the reference ladder (--list-packs → --dry-run)', () => {
    const skill = readSkillBundle();
    expect(skill).toContain('ok seed --list-packs');
    expect(skill).toContain('--dry-run');
  });
});
