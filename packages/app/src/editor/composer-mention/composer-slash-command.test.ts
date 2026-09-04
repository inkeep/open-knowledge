import { describe, expect, test } from 'vitest';
import {
  filterSlashCommands,
  leadingSlashToken,
  resolveSlashTokenHint,
  type SlashCommandItem,
} from './composer-slash-command';

const COMMANDS: SlashCommandItem[] = [
  { name: 'review', description: 'Review the current diff' },
  { name: 'create_plan', description: 'Draft an implementation plan' },
  { name: 'research_codebase', description: 'Deep-dive the codebase for planning' },
];

describe('filterSlashCommands', () => {
  test('an empty query returns every command in advertised order', () => {
    expect(filterSlashCommands(COMMANDS, '')).toEqual(COMMANDS);
    expect(filterSlashCommands(COMMANDS, '   ')).toEqual(COMMANDS);
  });

  test('name-prefix matches rank ahead of name-substring and description matches', () => {
    const ranked = filterSlashCommands(COMMANDS, 're');
    expect(ranked.map((c) => c.name)).toEqual(['review', 'research_codebase', 'create_plan']);
  });

  test('description-only matches still surface, last', () => {
    expect(filterSlashCommands(COMMANDS, 'diff').map((c) => c.name)).toEqual(['review']);
    expect(filterSlashCommands(COMMANDS, 'planning').map((c) => c.name)).toEqual([
      'research_codebase',
    ]);
  });

  test('matching is case-insensitive', () => {
    expect(filterSlashCommands(COMMANDS, 'REV').map((c) => c.name)).toEqual(['review']);
  });

  test('no match returns empty', () => {
    expect(filterSlashCommands(COMMANDS, 'zzz')).toEqual([]);
  });
});

describe('leadingSlashToken', () => {
  test('parses the leading /name and its length', () => {
    expect(leadingSlashToken('/review the diff')).toEqual({ name: 'review', length: 7 });
    expect(leadingSlashToken('/create_plan')).toEqual({ name: 'create_plan', length: 12 });
  });

  test('a bare slash is not a token', () => {
    expect(leadingSlashToken('/')).toBeNull();
    expect(leadingSlashToken('/ review')).toBeNull();
  });

  test('a slash later in the text is prose, not a command', () => {
    expect(leadingSlashToken('use /review')).toBeNull();
    expect(leadingSlashToken('and/or')).toBeNull();
    expect(leadingSlashToken('')).toBeNull();
  });
});

describe('resolveSlashTokenHint', () => {
  test('no leading token resolves to null', () => {
    expect(resolveSlashTokenHint('plain prose', COMMANDS)).toBeNull();
    expect(resolveSlashTokenHint('', COMMANDS)).toBeNull();
  });

  test('a not-yet-advertised corpus (null) makes no claim either way', () => {
    expect(resolveSlashTokenHint('/review', null)).toBeNull();
  });

  test('an advertised command resolves known, with its description', () => {
    expect(resolveSlashTokenHint('/review args here', COMMANDS)).toEqual({
      kind: 'known',
      name: 'review',
      description: 'Review the current diff',
    });
  });

  test('command names match exactly — no case folding or prefixing', () => {
    expect(resolveSlashTokenHint('/Review', COMMANDS)).toMatchObject({ kind: 'unknown' });
    expect(resolveSlashTokenHint('/rev', COMMANDS)).toMatchObject({ kind: 'unknown' });
  });

  test('an unknown token against a real corpus reports the agent HAS commands', () => {
    expect(resolveSlashTokenHint('/tasks', COMMANDS)).toEqual({
      kind: 'unknown',
      name: 'tasks',
      agentHasCommands: true,
    });
  });

  test('an unknown token against an advertised-empty corpus reports none exist', () => {
    expect(resolveSlashTokenHint('/tasks', [])).toEqual({
      kind: 'unknown',
      name: 'tasks',
      agentHasCommands: false,
    });
  });
});
