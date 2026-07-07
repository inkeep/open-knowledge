import { afterEach, describe, expect, it, mock } from 'bun:test';
import { toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import {
  __resetPageListCacheForTests,
  buildPageIconsIndex,
  buildPagesByBasenameIndex,
  getPageListCache,
  type PageListCacheSnapshot,
  setPageListCache,
  setsEqual,
  snapshotsEqual,
  subscribePageListCache,
} from './page-list-cache';

afterEach(() => {
  __resetPageListCacheForTests();
});

describe('setsEqual', () => {
  it('returns true for same-reference sets', () => {
    const s = new Set(['a', 'b']);
    expect(setsEqual(s, s)).toBe(true);
  });

  it('returns true for same-content sets', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
  });

  it('returns false when sizes differ', () => {
    expect(setsEqual(new Set(['a']), new Set(['a', 'b']))).toBe(false);
  });

  it('returns false when contents differ at same size', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'c']))).toBe(false);
  });

  it('returns true for two empty sets', () => {
    expect(setsEqual(new Set(), new Set())).toBe(true);
  });
});

describe('snapshotsEqual', () => {
  it('returns false when prev is null', () => {
    const next: PageListCacheSnapshot = { pages: new Set(), folderPaths: new Set() };
    expect(snapshotsEqual(null, next)).toBe(false);
  });

  it('returns true for same-reference snapshot', () => {
    const snap: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(),
    };
    expect(snapshotsEqual(snap, snap)).toBe(true);
  });

  it('returns true when pages+folderPaths content match across distinct refs', () => {
    const a: PageListCacheSnapshot = {
      pages: new Set(['x', 'y']),
      folderPaths: new Set(['dir']),
    };
    const b: PageListCacheSnapshot = {
      pages: new Set(['y', 'x']),
      folderPaths: new Set(['dir']),
    };
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it('returns false when pages differ', () => {
    const a: PageListCacheSnapshot = {
      pages: new Set(['x']),
      folderPaths: new Set(),
    };
    const b: PageListCacheSnapshot = {
      pages: new Set(['y']),
      folderPaths: new Set(),
    };
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('returns false when folderPaths differ', () => {
    const a: PageListCacheSnapshot = {
      pages: new Set(['x']),
      folderPaths: new Set(['dirA']),
    };
    const b: PageListCacheSnapshot = {
      pages: new Set(['x']),
      folderPaths: new Set(['dirB']),
    };
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('returns false when referenced asset paths differ', () => {
    const a: PageListCacheSnapshot = {
      pages: new Set(['x']),
      folderPaths: new Set(),
      assetPaths: new Set(['docs/image.png']),
    };
    const b: PageListCacheSnapshot = {
      pages: new Set(['x']),
      folderPaths: new Set(),
      assetPaths: new Set(['docs/other.png']),
    };
    expect(snapshotsEqual(a, b)).toBe(false);
  });
});

describe('getPageListCache', () => {
  it('returns null before any setPageListCache call', () => {
    expect(getPageListCache()).toBeNull();
  });

  it('returns the stored snapshot after setPageListCache', () => {
    const snap: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(['dir']),
    };
    setPageListCache(snap);
    expect(getPageListCache()).toBe(snap);
  });
});

describe('setPageListCache', () => {
  it('replaces the stored snapshot on content change', () => {
    setPageListCache({ pages: new Set(['a']), folderPaths: new Set() });
    const next: PageListCacheSnapshot = {
      pages: new Set(['a', 'b']),
      folderPaths: new Set(),
    };
    setPageListCache(next);
    expect(getPageListCache()).toBe(next);
  });

  it('is a no-op when content is equal (identity preserved)', () => {
    const first: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(['dir']),
    };
    setPageListCache(first);
    const equal: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(['dir']),
    };
    setPageListCache(equal);
    // Content-equal snapshot — store should NOT rotate identity.
    expect(getPageListCache()).toBe(first);
  });

  it('is a no-op for repeated identical reference', () => {
    const snap: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(),
    };
    setPageListCache(snap);
    const listener = mock(() => {});
    subscribePageListCache(listener);
    listener.mockClear();
    setPageListCache(snap);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('subscribePageListCache', () => {
  it('fires immediately on subscribe when a snapshot already exists', () => {
    const snap: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(),
    };
    setPageListCache(snap);
    const listener = mock(() => {});
    subscribePageListCache(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(snap);
  });

  it('does NOT fire immediately when cache is null at subscribe time', () => {
    const listener = mock(() => {});
    subscribePageListCache(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires on subsequent content-changing setPageListCache calls', () => {
    const listener = mock(() => {});
    subscribePageListCache(listener);
    const first: PageListCacheSnapshot = {
      pages: new Set(['a']),
      folderPaths: new Set(),
    };
    setPageListCache(first);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(first);
    const second: PageListCacheSnapshot = {
      pages: new Set(['a', 'b']),
      folderPaths: new Set(),
    };
    setPageListCache(second);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(second);
  });

  it('does NOT fire on content-equal setPageListCache calls', () => {
    const listener = mock(() => {});
    subscribePageListCache(listener);
    setPageListCache({ pages: new Set(['a']), folderPaths: new Set() });
    listener.mockClear();
    setPageListCache({ pages: new Set(['a']), folderPaths: new Set() });
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops subsequent notifications', () => {
    const listener = mock(() => {});
    const unsubscribe = subscribePageListCache(listener);
    unsubscribe();
    setPageListCache({ pages: new Set(['a']), folderPaths: new Set() });
    expect(listener).not.toHaveBeenCalled();
  });

  it('is safe to unsubscribe inside a listener (no double-fire on next change)', () => {
    let unsubscribe: (() => void) | null = null;
    const listener = mock(() => {
      unsubscribe?.();
    });
    unsubscribe = subscribePageListCache(listener);
    setPageListCache({ pages: new Set(['a']), folderPaths: new Set() });
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();
    setPageListCache({ pages: new Set(['a', 'b']), folderPaths: new Set() });
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple independent subscribers', () => {
    const a = mock(() => {});
    const b = mock(() => {});
    subscribePageListCache(a);
    subscribePageListCache(b);
    setPageListCache({ pages: new Set(['x']), folderPaths: new Set() });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('subscriber throw does NOT abort sibling notifications', () => {
    const original = console.error;
    const captured: unknown[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const bad = mock(() => {
        throw new Error('boom');
      });
      const good = mock(() => {});
      subscribePageListCache(bad);
      subscribePageListCache(good);
      setPageListCache({ pages: new Set(['x']), folderPaths: new Set() });
      expect(good).toHaveBeenCalledTimes(1);
      expect(captured.length).toBe(1);
    } finally {
      console.error = original;
    }
  });
});

describe('buildPageIconsIndex', () => {
  it('returns an empty map when no entries carry an icon', () => {
    const index = buildPageIconsIndex(
      new Map([
        ['a', { size: 1, modified: '2026-01-01' }],
        ['b', { size: 2, modified: '2026-01-02' }],
      ]),
    );
    expect(index.size).toBe(0);
  });

  it('projects the icon field while skipping blank values', () => {
    const index = buildPageIconsIndex(
      new Map([
        ['a', { icon: '📝' }],
        ['b', { icon: '' }],
        ['c', { icon: '   ' }],
        ['d', { icon: 'https://example.com/i.png' }],
        ['e', {}],
      ]),
    );
    expect(Array.from(index.entries())).toEqual([
      ['a', '📝'],
      ['d', 'https://example.com/i.png'],
    ]);
  });
});

describe('buildPagesByBasenameIndex', () => {
  it('keys subfolder pages by their leaf slug so [[name]] resolves to a/b/name', () => {
    const index = buildPagesByBasenameIndex(
      new Set(['andrew-data/project-x/analysis']),
      toWikiLinkSlug,
    );
    expect(index.get('analysis')).toBe('andrew-data/project-x/analysis');
  });

  it('alphabetical-first wins when two files share a basename', () => {
    const index = buildPagesByBasenameIndex(new Set(['z/foo', 'a/foo', 'm/foo']), toWikiLinkSlug);
    expect(index.get('foo')).toBe('a/foo');
  });

  it('slug-normalizes the basename so [[Project X]] keys against project-x', () => {
    const index = buildPagesByBasenameIndex(new Set(['subfolder/Project X']), toWikiLinkSlug);
    expect(index.get('project-x')).toBe('subfolder/Project X');
  });

  it('includes root-level pages keyed by their own slug', () => {
    const index = buildPagesByBasenameIndex(new Set(['readme', 'a/foo']), toWikiLinkSlug);
    expect(index.get('readme')).toBe('readme');
    expect(index.get('foo')).toBe('a/foo');
  });

  it('returns an empty map for an empty pages set', () => {
    expect(buildPagesByBasenameIndex(new Set(), toWikiLinkSlug).size).toBe(0);
  });
});

describe('snapshotsEqual — pageIcons', () => {
  function snap(overrides: Partial<PageListCacheSnapshot> = {}): PageListCacheSnapshot {
    return {
      pages: new Set(),
      folderPaths: new Set(),
      pagesBySlug: new Map(),
      ...overrides,
    };
  }

  it('treats undefined pageIcons as equal to an empty map', () => {
    const a = snap({});
    const b = snap({ pageIcons: new Map() });
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it('returns true when pageIcons have identical content', () => {
    const a = snap({ pageIcons: new Map([['x', '📝']]) });
    const b = snap({ pageIcons: new Map([['x', '📝']]) });
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it('returns false when pageIcons values differ', () => {
    const a = snap({ pageIcons: new Map([['x', '📝']]) });
    const b = snap({ pageIcons: new Map([['x', '📘']]) });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it('returns false when pageIcons sizes differ', () => {
    const a = snap({ pageIcons: new Map([['x', '📝']]) });
    const b = snap({ pageIcons: new Map() });
    expect(snapshotsEqual(a, b)).toBe(false);
  });
});
