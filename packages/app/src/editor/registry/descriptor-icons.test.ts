/**
 * Every icon name a registered descriptor declares must have an explicit
 * entry in `ICON_COMPONENTS` — `resolveIcon` falls back to a generic icon
 * for unmapped names, silently, in both surfaces that share the map (slash
 * menu + placeholder pill). This trips when a descriptor lands with an
 * icon that was never added to the map. Checked via `hasIconMapping`
 * rather than comparing `resolveIcon`'s result against the fallback
 * component, which would misfire if a descriptor legitimately used the
 * fallback icon by name.
 */

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
