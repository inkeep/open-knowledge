import {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  resolveWikiLinkTargetDocName,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { docNameForNavigationTarget, resolveNavigationTarget } from './navigation-targets';

function lookupFor(pages: ReadonlySet<string>): WikiLinkLookupIndex {
  return {
    pages,
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
  };
}

function viaNavigation(target: string, pages: ReadonlySet<string>): string | null {
  const lookup = lookupFor(pages);
  return docNameForNavigationTarget(
    resolveNavigationTarget(target, {
      pages,
      pagesBySlug: lookup.pagesBySlug,
      pagesByBasename: lookup.pagesByBasename,
    }),
  );
}

function viaShared(target: string, pages: ReadonlySet<string>): string | undefined {
  return resolveWikiLinkTargetDocName(target, lookupFor(pages));
}

describe('bare-name resolution ordering contract', () => {
  test('both resolvers name the same document when a basename collides across folders', () => {
    const pages = new Set(['research/analysis', 'archive/analysis']);

    const navigation = viaNavigation('analysis', pages);
    const shared = viaShared('analysis', pages);

    expect(shared).toBeDefined();
    expect(navigation).toBe(shared);
  });

  test('the winner is code-unit ordered, not locale ordered', () => {
    const pages = new Set(['B/notes', 'a/notes']);

    expect(viaShared('notes', pages)).toBe('B/notes');
    expect(viaNavigation('notes', pages)).toBe('B/notes');
  });

  test('a dotted basename resolves identically through both resolvers', () => {
    const pages = new Set(['Memory/ACP/entities/acp.daemon', 'sub/plain']);

    expect(viaShared('acp.daemon', pages)).toBe('Memory/ACP/entities/acp.daemon');
    expect(viaNavigation('acp.daemon', pages)).toBe('Memory/ACP/entities/acp.daemon');
  });

  test('the dot-free control resolves identically through both resolvers', () => {
    const pages = new Set(['Memory/ACP/entities/acp.daemon', 'sub/plain']);

    expect(viaShared('plain', pages)).toBe('sub/plain');
    expect(viaNavigation('plain', pages)).toBe('sub/plain');
  });

  test('ordering is stable no matter what order the corpus is enumerated in', () => {
    const forward = new Set(['B/notes', 'a/notes']);
    const reversed = new Set(['a/notes', 'B/notes']);

    expect(viaShared('notes', forward)).toBe(viaShared('notes', reversed));
    expect(viaNavigation('notes', forward)).toBe(viaNavigation('notes', reversed));
  });
});
