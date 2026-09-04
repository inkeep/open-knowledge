import { describe, expect, test } from 'vitest';
import type { EditorId } from '../constants/editors.ts';
import type { SkillScope } from '../schemas/api/tags-search.ts';
import {
  buildSkillRegistry,
  type LocatedSkillOccurrence,
  skillRegistryKey,
} from './skill-registry.ts';

function loc(
  name: string,
  editor: EditorId,
  contentHash: string,
  dir: string,
  scope: SkillScope = 'project',
): LocatedSkillOccurrence {
  return { name, scope, editor, contentHash, dir };
}

describe('buildSkillRegistry', () => {
  test('one canonical, copies excluded from admission', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'claude', 'h', '.claude/skills/foo'),
      loc('foo', 'codex', 'h', '.codex/skills/foo'),
    ]);
    expect(reg.canonicalDir.get(skillRegistryKey('project', 'foo'))).toBe('.claude/skills/foo');
    expect([...reg.admittedDirs]).toEqual(['.claude/skills/foo']);
    expect([...reg.excludedCopyDirs]).toEqual(['.codex/skills/foo']);
  });

  test('same name, different content: BOTH admitted, neither hidden', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'codex', 'h2', '.codex/skills/foo'),
      loc('foo', 'claude', 'h1', '.claude/skills/foo'),
    ]);
    expect([...reg.admittedDirs].sort()).toEqual(['.claude/skills/foo', '.codex/skills/foo']);
    expect(reg.excludedCopyDirs.size).toBe(0);
    expect(reg.canonicalDir.get(skillRegistryKey('project', 'foo'))).toBe('.claude/skills/foo');
  });

  test('three distinct contents under one name admit three dirs', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'claude', 'h1', '.claude/skills/foo'),
      loc('foo', 'codex', 'h2', '.codex/skills/foo'),
      loc('foo', 'cursor', 'h3', '.cursor/skills/foo'),
    ]);
    expect(reg.admittedDirs.size).toBe(3);
    expect(reg.excludedCopyDirs.size).toBe(0);
  });

  test('a same-named sibling still dedups its OWN copies', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'claude', 'h1', '.claude/skills/foo'),
      loc('foo', 'cursor', 'h1', '.cursor/skills/foo'),
      loc('foo', 'codex', 'h2', '.codex/skills/foo'),
    ]);
    expect([...reg.admittedDirs].sort()).toEqual(['.claude/skills/foo', '.codex/skills/foo']);
    expect([...reg.excludedCopyDirs]).toEqual(['.cursor/skills/foo']);
  });

  test('a user-preferred source wins the by-name default over precedence', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'claude', 'h1', '.claude/skills/foo'),
      { ...loc('foo', 'codex', 'h2', '.codex/skills/foo'), preferredSource: true },
    ]);
    expect(reg.canonicalDir.get(skillRegistryKey('project', 'foo'))).toBe('.codex/skills/foo');
    expect(reg.admittedDirs.size).toBe(2);
  });

  test('project and global same-name are distinct canonical bindings', () => {
    const reg = buildSkillRegistry([
      loc('foo', 'claude', 'h', '.claude/skills/foo', 'project'),
      loc('foo', 'claude', 'h', '~/.claude/skills/foo', 'global'),
    ]);
    expect(reg.canonicalDir.get(skillRegistryKey('project', 'foo'))).toBe('.claude/skills/foo');
    expect(reg.canonicalDir.get(skillRegistryKey('global', 'foo'))).toBe('~/.claude/skills/foo');
  });
});
