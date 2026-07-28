import { describe, expect, test } from 'vitest';
import { deriveInstanceUserDataDir, sanitizeInstanceName } from './instance-isolation.ts';

describe('sanitizeInstanceName', () => {
  test('passes simple alphanumeric names through unchanged', () => {
    expect(sanitizeInstanceName('a')).toBe('a');
    expect(sanitizeInstanceName('feature2')).toBe('feature2');
    expect(sanitizeInstanceName('v1.2')).toBe('v1.2');
    expect(sanitizeInstanceName('my_branch-3')).toBe('my_branch-3');
  });

  test('collapses disallowed characters (incl. path separators) to a dash', () => {
    expect(sanitizeInstanceName('my work')).toBe('my-work');
    expect(sanitizeInstanceName('a/b\\c')).toBe('a-b-c');
    expect(sanitizeInstanceName('emoji🚀name')).toBe('emoji-name');
  });

  test('strips leading/trailing dots and dashes so traversal/dotfile names cannot survive', () => {
    expect(sanitizeInstanceName('..')).toBe('');
    expect(sanitizeInstanceName('../evil')).toBe('evil');
    expect(sanitizeInstanceName('.hidden')).toBe('hidden');
    expect(sanitizeInstanceName('-edge-')).toBe('edge');
  });

  test('returns empty for names that reduce to nothing', () => {
    expect(sanitizeInstanceName('')).toBe('');
    expect(sanitizeInstanceName('   ')).toBe('');
    expect(sanitizeInstanceName('/')).toBe('');
  });

  test('bounds the length to 64 characters', () => {
    expect(sanitizeInstanceName('x'.repeat(200))).toHaveLength(64);
  });
});

describe('deriveInstanceUserDataDir', () => {
  test('appends the sanitized name as a sibling directory suffix', () => {
    expect(
      deriveInstanceUserDataDir('/Users/me/Library/Application Support/OpenKnowledge', 'b'),
    ).toBe('/Users/me/Library/Application Support/OpenKnowledge (b)');
  });

  test('uses the sanitized form of the name', () => {
    expect(deriveInstanceUserDataDir('/data/OpenKnowledge', 'my work/2')).toBe(
      '/data/OpenKnowledge (my-work-2)',
    );
  });

  test('returns null when the name sanitizes to empty (leave userData untouched)', () => {
    expect(deriveInstanceUserDataDir('/data/OpenKnowledge', '..')).toBeNull();
    expect(deriveInstanceUserDataDir('/data/OpenKnowledge', '   ')).toBeNull();
  });

  test('keeps the relocated dir a sibling of the base (no escape above its parent)', () => {
    const out = deriveInstanceUserDataDir('/data/OpenKnowledge', '../../etc');
    expect(out).toBe('/data/OpenKnowledge (etc)');
  });
});
