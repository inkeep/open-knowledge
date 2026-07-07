/**
 * Unit tests for the wiki-link chip's icon-prefix helpers.
 *
 * `getWikiLinkIcon` is the pure resolver: target + cache → ResolvedPageIcon
 * | null. `syncWikiLinkIconSlot` is the DOM-touching applier that mutates a
 * pre-allocated `<span data-wiki-link-icon>` to match the resolved icon.
 *
 * The NodeView wires both — initial render + on every page-list-cache push
 * — so frontmatter edits to the LINKED page propagate to every chip
 * referencing it without a NodeView remount.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { PageListCacheSnapshot } from '../page-list-cache';
import { getWikiLinkIcon, syncWikiLinkIconSlot } from './wiki-link';

afterEach(cleanup);

function makeCache(overrides: Partial<PageListCacheSnapshot> = {}): PageListCacheSnapshot {
  return {
    pages: new Set(),
    folderPaths: new Set(),
    pagesBySlug: new Map(),
    assetPaths: new Set(),
    pageIcons: new Map(),
    ...overrides,
  };
}

describe('getWikiLinkIcon', () => {
  test('returns null when the cache is null', () => {
    expect(getWikiLinkIcon('docs/welcome', null)).toBeNull();
  });

  test('returns null when target is empty', () => {
    expect(getWikiLinkIcon('', makeCache())).toBeNull();
    expect(getWikiLinkIcon('   ', makeCache())).toBeNull();
  });

  test('returns null when the page exists but has no icon', () => {
    const cache = makeCache({
      pages: new Set(['docs/welcome']),
    });
    expect(getWikiLinkIcon('docs/welcome', cache)).toBeNull();
  });

  test('resolves emoji icons against a direct page-set match', () => {
    const cache = makeCache({
      pages: new Set(['docs/welcome']),
      pageIcons: new Map([['docs/welcome', '👋']]),
    });
    expect(getWikiLinkIcon('docs/welcome', cache)).toEqual({
      kind: 'emoji',
      value: '👋',
    });
  });

  test('resolves icons via slug fallback (case-folded target)', () => {
    // Drop-flow shape: chip target='readme' (slug); cache has 'README'.
    const cache = makeCache({
      pages: new Set(['README']),
      pagesBySlug: new Map([['readme', 'README']]),
      pageIcons: new Map([['README', '📘']]),
    });
    expect(getWikiLinkIcon('readme', cache)).toEqual({ kind: 'emoji', value: '📘' });
  });

  test('returns null when the icon string fails resolvePageIcon classification', () => {
    // Plain text — not emoji-shaped, not URL/path-shaped → unsupported.
    const cache = makeCache({
      pages: new Set(['docs/welcome']),
      pageIcons: new Map([['docs/welcome', 'just-some-text']]),
    });
    expect(getWikiLinkIcon('docs/welcome', cache)).toBeNull();
  });

  test('resolves URL-shaped icons', () => {
    const cache = makeCache({
      pages: new Set(['docs/welcome']),
      pageIcons: new Map([['docs/welcome', 'https://example.com/icon.png']]),
    });
    const icon = getWikiLinkIcon('docs/welcome', cache);
    expect(icon?.kind).toBe('url');
    expect(icon?.value).toBe('https://example.com/icon.png');
  });
});

describe('syncWikiLinkIconSlot', () => {
  function makeSlot(): HTMLElement {
    const el = document.createElement('span');
    el.setAttribute('data-wiki-link-icon', '');
    return el;
  }

  test('renders an emoji as a text node', () => {
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🚀' });
    expect(slot.textContent).toBe('🚀');
    expect(slot.querySelector('img')).toBeNull();
    expect(slot.getAttribute('data-kind')).toBe('emoji');
  });

  test('renders a URL icon as an <img>', () => {
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'url', value: 'https://example.com/icon.png' });
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.com/icon.png');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.getAttribute('draggable')).toBe('false');
    // Leaking the doc path via Referer to an external host is a
    // privacy hole — match the established `Embed` / `CodeBlockView`
    // / `Image` posture and the matching `<img referrerpolicy>` on
    // `PageHeader`.
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(slot.getAttribute('data-kind')).toBe('url');
  });

  test('renders a path icon as an <img> (toDesktopAssetHref-wrapped src)', () => {
    // Path-kind values arrive pre-wrapped — `resolvePageIcon`
    // (in `page-header-utils.ts`) calls `toDesktopAssetHref` on the
    // raw frontmatter value before reaching the slot. The slot itself
    // is dumb — it just renders whatever `src` it gets.
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'path', value: '/api/asset?path=assets%2Ficon.png' });
    const img = slot.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/api/asset?path=assets%2Ficon.png');
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(slot.getAttribute('data-kind')).toBe('path');
  });

  test('clears the slot when icon is null (no-icon state)', () => {
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🚀' });
    syncWikiLinkIconSlot(slot, null);
    expect(slot.textContent).toBe('');
    expect(slot.querySelector('img')).toBeNull();
    expect(slot.getAttribute('data-kind')).toBe('');
    expect(slot.getAttribute('data-value')).toBe('');
  });

  test('is idempotent — repeating the same icon does not touch the DOM', () => {
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🚀' });
    const firstChild = slot.firstChild;
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🚀' });
    // Same text node instance — no removeChild/appendChild churn.
    expect(slot.firstChild).toBe(firstChild);
  });

  test('replaces an emoji with an <img> on kind change', () => {
    const slot = makeSlot();
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🚀' });
    syncWikiLinkIconSlot(slot, { kind: 'url', value: 'https://example.com/icon.png' });
    expect(slot.textContent).toBe('');
    expect(slot.querySelector('img')?.getAttribute('src')).toBe('https://example.com/icon.png');
  });

  test('mutates an RTL-rendered icon slot in place (NodeView host parity)', () => {
    // Mirrors production wiring: the NodeView mounts `<span
    // data-wiki-link-icon>` into the chip DOM and then
    // `syncWikiLinkIconSlot` imperatively rewrites its children on every
    // page-list-cache change. Mounting the slot via RTL pins this works
    // alongside a React-managed subtree, not just in a detached node.
    const { container } = render(<span data-wiki-link-icon="" />);
    const slot = container.firstChild as HTMLElement;
    syncWikiLinkIconSlot(slot, { kind: 'emoji', value: '🎯' });
    expect(slot.textContent).toBe('🎯');
  });
});
