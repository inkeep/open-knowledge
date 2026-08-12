import {
  buildPagesByBasenameIndex,
  buildPagesBySlugIndex,
  resolveWikiLinkTargetDocName,
  toWikiLinkSlug,
  type WikiLinkLookupIndex,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { docNameForNavigationTarget, resolveNavigationTarget } from './navigation-targets';

/**
 * Two resolvers answer "which document does this bare name mean": the shared
 * one the server and the chip's resolved-state read, and the navigation
 * resolver the click destination reads. They are deliberately separate — the
 * navigation resolver carries managed-artifact and editable-text branches that
 * cannot move into the shared package — so nothing in the type system stops
 * them drifting apart on WHICH document wins.
 *
 * That drift is the defect this file exists to catch: a bare name resolving one
 * way for navigation and another way for the dead-link verdict is how a link
 * gets reported broken while the reader clicks it and arrives.
 *
 * The contract is a single ordering, and it is enforced structurally — the
 * tie-break happens once, when the basename index is built, so both resolvers
 * consume the same already-decided winner. These tests pin that the two agree
 * AND that the ordering is the runtime-independent one.
 */

function lookupFor(pages: ReadonlySet<string>): WikiLinkLookupIndex {
  return {
    pages,
    pagesBySlug: buildPagesBySlugIndex(pages, toWikiLinkSlug),
    pagesByBasename: buildPagesByBasenameIndex(pages, toWikiLinkSlug),
  };
}

/** Resolve through the navigation path the way a click does. */
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

/** Resolve through the shared path the dead-link verdict reads. */
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
    // 'B' (0x42) sorts before 'a' (0x61) by code unit, but after it under a
    // locale-aware collation. This fixture is the one that tells those two
    // apart, so it fails if the pinned comparator is ever swapped back to
    // `localeCompare` — the state in which two runtimes could disagree.
    const pages = new Set(['B/notes', 'a/notes']);

    expect(viaShared('notes', pages)).toBe('B/notes');
    expect(viaNavigation('notes', pages)).toBe('B/notes');
  });

  test('a dotted basename resolves identically through both resolvers', () => {
    // The reported defect: a dot in the filename used to divert this target
    // into asset classification before either resolver saw it.
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
    // Set iteration order follows insertion, so a corpus discovered in a
    // different order must not produce a different winner.
    const forward = new Set(['B/notes', 'a/notes']);
    const reversed = new Set(['a/notes', 'B/notes']);

    expect(viaShared('notes', forward)).toBe(viaShared('notes', reversed));
    expect(viaNavigation('notes', forward)).toBe(viaNavigation('notes', reversed));
  });
});
