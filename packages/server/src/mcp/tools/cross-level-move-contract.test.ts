import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CROSS_LEVEL_TRANSFER_CLAUSE, DROPPED_LOCATIONS_DESCRIPTION } from './move.ts';
import { crossScopeMoveSuccessText } from './skill-target.ts';

const repoFile = (...segments: string[]) =>
  readFileSync(join(import.meta.dir, '../../..', ...segments), 'utf-8');

const PROJECT_SKILL = repoFile('assets', 'skills', 'project', 'SKILL.md');
const MCP_REFERENCE = repoFile('../../docs/content/reference/mcp.mdx');
const SKILLS_REFERENCE = repoFile('../../docs/content/features/skills/reference.mdx');
const CHANGESET = repoFile('../../.changeset/fluffy-clouds-report.md');

function mcpReferenceRow(tool: string): string {
  const row = MCP_REFERENCE.split('\n').find((line) => line.startsWith(`| \`${tool}\` |`));
  if (row === undefined) throw new Error(`no mcp.mdx table row for \`${tool}\``);
  return row;
}

const successText = crossScopeMoveSuccessText({
  fromName: 'trip-log',
  toName: 'trip-log',
  fromScope: 'global',
  toScope: 'project',
  droppedLocations: [],
});

const SURFACES: ReadonlyArray<readonly [string, string]> = [
  ['move `toScope` / `crossScope` clause', CROSS_LEVEL_TRANSFER_CLAUSE],
  ['move `droppedLocations` description', DROPPED_LOCATIONS_DESCRIPTION],
  ['moveSkillCrossScope success text', successText],
  ['project SKILL.md router bullet', PROJECT_SKILL],
  ['docs mcp.mdx `move` row', mcpReferenceRow('move')],
  ['docs features/skills/reference.mdx scope-move paragraph', SKILLS_REFERENCE],
  ['the changeset release note', CHANGESET],
];

const ENUMERATING: ReadonlyArray<readonly [string, string]> = SURFACES.filter(
  ([name]) =>
    name !== 'project SKILL.md router bullet' && name !== 'moveSkillCrossScope success text',
);

const OUTCOME_INDEPENDENT: ReadonlyArray<readonly [string, string]> = SURFACES.filter(
  ([name]) => name !== 'moveSkillCrossScope success text',
);

describe('cross-level skill move — what re-projects and what drops, stated in lockstep', () => {
  test('every surface derives the split from what the destination can host or place, not from a fixed list', () => {
    for (const [name, surface] of SURFACES) {
      expect(surface, name).toMatch(
        /(?:destination|Project|Global) (?:level|scope) can(?:not)? (?:host|place)/i,
      );
    }
  });

  test('the split is stated as a capability, never negated at this clause', () => {
    for (const [name, surface] of SURFACES) {
      expect(surface, name).not.toMatch(
        /(?:destination|Project|Global) (?:level|scope) cannot (?:host|place)/i,
      );
    }
  });

  test('every surface with room names all three dropped classes, editors included', () => {
    for (const [name, surface] of ENUMERATING) {
      expect(surface, `${name} — the \`agents\` hub`).toMatch(/`(?:agents|\.agents\/skills)`/);
      expect(surface, `${name} — custom roots`).toMatch(/custom roots?|Add custom path/);
      expect(surface, `${name} — editors with no root at that level`).toMatch(
        /no skills (?:root|folder) at that (?:level|scope)/,
      );
    }
  });

  test('the router bullet states the rule by cause and still names the field to read', () => {
    expect(PROJECT_SKILL).toContain('only what the destination level can host re-projects');
    expect(PROJECT_SKILL).toContain(
      'the rest is removed at source, returned as `droppedLocations`',
    );
  });

  test('no surface states the re-add remedy without naming the outcome it holds for', () => {
    const remedy = /re-add(?:ing)?|add the ones|adding them|go back with/gi;
    for (const [name, surface] of OUTCOME_INDEPENDENT) {
      const stated = [...surface.matchAll(remedy)];
      expect(stated.length, `${name} — states the remedy at all`).toBeGreaterThan(0);
      for (const match of stated) {
        expect(
          surface.slice(Math.max(0, match.index - 600), match.index + match[0].length + 600),
          `${name} — the remedy at ${match.index} names the outcome it holds for`,
        ).toMatch(/succe|fail/i);
      }
    }
  });

  test('no surface still claims every occupied location is re-projected', () => {
    for (const [name, surface] of SURFACES) {
      expect(surface, name).not.toMatch(/editor locations it (?:occupied|already occupied)/);
    }
  });
});

describe('the dropped-location remedy an agent is told to run', () => {
  const move = (droppedLocations: readonly string[], toScope: 'project' | 'global') =>
    crossScopeMoveSuccessText({
      fromName: 'trip-log',
      toName: 'trip-log',
      fromScope: toScope === 'project' ? 'global' : 'project',
      toScope,
      droppedLocations,
    });

  test('a hub-reading editor with no destination root gets the `agents` equivalent, not a no-op install', () => {
    const text = move(['lm-studio'], 'project');
    expect(text).toContain('no Project-level skills root');
    expect(text).toContain('install({ name: "trip-log", scope: "project", add: ["agents"] })');
    expect(text).not.toContain('add: ["lm-studio"]');
  });

  test('an editor with no destination root and no hub fallback is told no placement exists', () => {
    const text = move(['antigravity'], 'project');
    expect(text).toContain('no Project-level placement exists');
    expect(text).not.toContain('add: ["antigravity"]');
  });

  test('placeable locations keep the rendered install call and the custom-root base caveat', () => {
    const text = move(['.team/skills', 'agents'], 'global');
    expect(text).toContain(
      'install({ name: "trip-log", scope: "global", add: [".team/skills", "agents"] })',
    );
    expect(text).toContain('destination base — your home directory —');
  });

  test('a mixed list splits: placeable ones are installed, unplaceable ones are called out', () => {
    const text = move(['agents', 'lm-studio', 'antigravity'], 'project');
    expect(text).toContain('install({ name: "trip-log", scope: "project", add: ["agents"] })');
    expect(text).toContain('lm-studio');
    expect(text).toContain('antigravity');
    expect(text).not.toContain('add: ["agents", "lm-studio", "antigravity"]');
  });

  test('a list mixing all three classes renders one install call naming only the placeable ones', () => {
    const text = move(['agents', '.team/skills', 'lm-studio', 'antigravity'], 'project');
    expect(text).toContain(
      'install({ name: "trip-log", scope: "project", add: ["agents", ".team/skills"] })',
    );
    expect(text).not.toContain('add: ["agents", ".team/skills", "lm-studio"');
    expect(text).toContain('destination base — the project directory —');
    expect(text).toContain(
      'lm-studio has no Project-level skills root, so `install` cannot place the skill there',
    );
    expect(text).toContain(
      'antigravity has no Project-level skills root and does not read the `agents` hub there, so no Project-level placement exists',
    );
  });

  test('nothing dropped means no remedy sentence at all', () => {
    expect(move([], 'global')).not.toContain('install(');
  });
});
