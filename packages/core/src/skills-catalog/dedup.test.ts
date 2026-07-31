import { describe, expect, test } from 'vitest';
import type { EditorId } from '../constants/editors.ts';
import { groupSkillsByIdentity, type SkillOccurrence } from './dedup.ts';

function occ(
  name: string,
  editor: EditorId,
  contentHash: string,
  scope: SkillOccurrence['scope'] = 'project',
): SkillOccurrence {
  return { name, scope, editor, contentHash };
}

describe('groupSkillsByIdentity', () => {
  test('same name + same hash across editors collapses to one canonical + copies', () => {
    const groups = groupSkillsByIdentity([
      occ('foo', 'codex', 'h1'),
      occ('foo', 'claude', 'h1'),
      occ('foo', 'cursor', 'h1'),
    ]);
    expect(groups).toHaveLength(1);
    // Precedence: claude wins over cursor/codex.
    expect(groups[0]?.canonical.editor).toBe('claude');
    expect(groups[0]?.copies.map((c) => c.editor).sort()).toEqual(['codex', 'cursor']);
    expect(groups[0]?.isFork).toBe(false);
  });

  test('same name + DIFFERENT hash is a FORK — two groups, never merged (S1 guard)', () => {
    const groups = groupSkillsByIdentity([occ('foo', 'claude', 'h1'), occ('foo', 'codex', 'h2')]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.isFork)).toBe(true);
    // Each fork keeps its own occurrence as canonical; no cross-copying.
    const byHash = new Map(groups.map((g) => [g.contentHash, g]));
    expect(byHash.get('h1')?.canonical.editor).toBe('claude');
    expect(byHash.get('h1')?.copies).toHaveLength(0);
    expect(byHash.get('h2')?.canonical.editor).toBe('codex');
    expect(byHash.get('h2')?.copies).toHaveLength(0);
  });

  test('mixed: a deduped skill and an unrelated fork-pair coexist', () => {
    const groups = groupSkillsByIdentity([
      occ('shared', 'claude', 'a'),
      occ('shared', 'codex', 'a'), // copy of shared
      occ('forked', 'claude', 'x'),
      occ('forked', 'cursor', 'y'), // fork of forked
    ]);
    const shared = groups.find((g) => g.name === 'shared');
    expect(shared?.isFork).toBe(false);
    expect(shared?.copies).toHaveLength(1);
    expect(groups.filter((g) => g.name === 'forked').every((g) => g.isFork)).toBe(true);
  });

  test('precedence: opencode/pi/copilot lose to claude even when listed first', () => {
    const groups = groupSkillsByIdentity([occ('foo', 'copilot', 'h'), occ('foo', 'claude', 'h')]);
    expect(groups[0]?.canonical.editor).toBe('claude');
  });

  test('a project skill and a global skill with the same name never merge or fork', () => {
    const groups = groupSkillsByIdentity([
      occ('foo', 'claude', 'h', 'project'),
      occ('foo', 'claude', 'h', 'global'),
    ]);
    expect(groups).toHaveLength(2);
    // Same name, same hash, DIFFERENT scope → two independent identities, neither a fork.
    expect(groups.every((g) => !g.isFork)).toBe(true);
    expect(groups.map((g) => g.scope).sort()).toEqual(['global', 'project']);
  });

  test('empty input yields no groups', () => {
    expect(groupSkillsByIdentity([])).toEqual([]);
  });
});
