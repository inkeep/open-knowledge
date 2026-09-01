import { builtInComponents } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { hasIconMapping } from './icons.ts';

describe('descriptor icon coverage', () => {
  test('every declared descriptor icon has an explicit ICON_COMPONENTS mapping', () => {
    const unmapped = builtInComponents
      .filter((meta) => meta.icon !== undefined)
      .filter((meta) => !hasIconMapping(meta.icon as string))
      .map((meta) => `${meta.name} -> ${meta.icon}`);
    expect(unmapped).toEqual([]);
  });
});
