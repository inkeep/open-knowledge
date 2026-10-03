import { describe, expect, test } from 'vitest';
import { folderNamesContain } from './folder-index-membership.ts';

describe('folderNamesContain', () => {
  test('an NFC folder query matches an NFD folder index key', () => {
    const index = new Map<string, unknown>([['People/Ren\u0065\u0301', {}]]);
    expect(folderNamesContain(index.keys(), 'People/Ren\u00E9')).toBe(true);
  });

  test('an NFD folder query matches an NFC folder index key', () => {
    const index = new Map<string, unknown>([['People/Ren\u00E9', {}]]);
    expect(folderNamesContain(index.keys(), 'People/Ren\u0065\u0301')).toBe(true);
  });

  test('a different folder is absent', () => {
    const index = new Map<string, unknown>([['People', {}]]);
    expect(folderNamesContain(index.keys(), 'Places')).toBe(false);
  });

  test('an accented folder does not match its unaccented name', () => {
    expect(folderNamesContain(new Set(['People/Rene']), 'People/Ren\u00E9')).toBe(false);
  });
});
