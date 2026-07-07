import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STARTER_PACK_IDS } from './starter.ts';

// The project skill carries a hand-written starter-pack awareness list (names +
// short hints) so an agent knows which archetypes exist and can reach for one.
// Names live in the skill; descriptions stay single-source in the registry.
// This guard keeps that list honest: adding / renaming / removing a pack fails
// here until the skill is updated in lock-step.
//
// The skill is split into a lean core SKILL.md + on-demand `references/*.md`, and
// the pack list lives in a reference (`workflow-guides.md`). Read the WHOLE
// bundle (core + every reference) so the guard finds the list wherever it lives.
const SKILL_DIR = join(import.meta.dir, '../../assets/skills/project');
// Matches each pack bullet: `- \`<id>\` — <hint>` (em-dash). Verified unique to
// the pack list — no other bullet in the bundle uses this exact shape.
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
