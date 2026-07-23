import { describe, expect, test } from 'vitest';
import { mergePatch } from './frontmatter-merge.ts';

describe('mergePatch — write path (scalars + arrays REPLACE; empties drop)', () => {
  test('scalars in patch replace existing', () => {
    const merged = mergePatch({ title: 'Old' }, { title: 'New' });
    expect(merged.title).toBe('New');
  });

  test('arrays in patch REPLACE existing (no union)', () => {
    const merged = mergePatch({ tags: ['a', 'b'] }, { tags: ['c'] });
    expect(merged.tags).toEqual(['c']);
  });

  test('null clears the key', () => {
    const merged = mergePatch({ title: 'old' }, { title: null });
    expect('title' in merged).toBe(false);
  });

  test('empty string clears the key', () => {
    const merged = mergePatch({ title: 'old' }, { title: '' });
    expect('title' in merged).toBe(false);
  });

  test('empty array clears the key', () => {
    const merged = mergePatch({ tags: ['a'] }, { tags: [] });
    expect('tags' in merged).toBe(false);
  });

  test('undefined keeps existing key', () => {
    const merged = mergePatch({ title: 'keep' }, { title: undefined });
    expect(merged.title).toBe('keep');
  });

  test('mixed patch: replaces some, clears one, keeps another', () => {
    const merged = mergePatch(
      { title: 'old', description: 'keep me', tags: ['x'] },
      { title: 'new', tags: null },
    );
    expect(merged).toEqual({ title: 'new', description: 'keep me' });
  });

  test('arbitrary keys (status, team, owners) work the same', () => {
    const merged = mergePatch(
      { status: 'draft', team: 'eng' },
      { status: 'review', owners: ['alice'], team: '' },
    );
    expect(merged).toEqual({ status: 'review', owners: ['alice'] });
  });
});
