import { describe, expect, test } from 'vitest';
import { createPagePathFromSeed } from './create-page';

describe('createPagePathFromSeed', () => {
  test('creates a root markdown path from a suggested name', () => {
    expect(createPagePathFromSeed({ initialDir: '', suggestedName: 'new-note.md' })).toBe(
      'new-note.md',
    );
  });

  test('preserves nested initial directory', () => {
    expect(createPagePathFromSeed({ initialDir: 'docs/guides', suggestedName: 'intro.md' })).toBe(
      'docs/guides/intro.md',
    );
  });

  test('normalizes leading and trailing directory slashes', () => {
    expect(createPagePathFromSeed({ initialDir: '/docs/', suggestedName: 'intro' })).toBe(
      'docs/intro.md',
    );
  });

  test('preserves supported typed extension', () => {
    expect(createPagePathFromSeed({ initialDir: 'docs', suggestedName: 'intro.mdx' })).toBe(
      'docs/intro.mdx',
    );
  });
});
