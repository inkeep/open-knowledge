import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { anchorFromHash } from '../lib/doc-hash';
import { REPEAT_ANCHOR_NAV_EVENT } from './anchor-navigation-event';
import { findAnchorTarget } from './anchor-target';
import { navigateToMarkdownTarget } from './internal-link-helpers';

beforeAll(() => {
  if (typeof globalThis.CSS?.escape !== 'function') {
    vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) });
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  document.body.replaceChildren();
  window.location.hash = '';
  vi.restoreAllMocks();
});

function mountHeading(id: string): HTMLElement {
  const heading = document.createElement('h2');
  heading.id = id;
  heading.textContent = id;
  document.body.append(heading);
  return heading;
}

function anchorOfCurrentHash(): string {
  return anchorFromHash(window.location.hash) ?? '';
}

describe('navigateToMarkdownTarget — in-document anchors', () => {
  test('navigates to the heading whose id is the anchor', () => {
    const heading = mountHeading('install');
    window.location.hash = '#/docs/guide';
    navigateToMarkdownTarget({ kind: 'anchor', anchor: 'install' }, '#/docs/guide');
    expect(window.location.hash).toBe('#/docs/guide#install');
    expect(findAnchorTarget(document, anchorOfCurrentHash())).toBe(heading);
  });

  test('navigates to a Korean heading from an anchor saved as decomposed jamo', () => {
    const heading = mountHeading('한국어');
    window.location.hash = '#/docs/guide';
    navigateToMarkdownTarget({ kind: 'anchor', anchor: '한국어'.normalize('NFD') }, '#/docs/guide');
    expect(findAnchorTarget(document, anchorOfCurrentHash())).toBe(heading);
  });

  test('a link to the anchor already in the address asks the editor to scroll again', () => {
    const target = '#/docs/guide#install';
    window.location.hash = target;
    const repeat = vi.fn();
    window.addEventListener(REPEAT_ANCHOR_NAV_EVENT, repeat);
    try {
      navigateToMarkdownTarget({ kind: 'anchor', anchor: 'install' }, target);
      expect(repeat).toHaveBeenCalledOnce();
      expect(window.location.hash).toBe(target);
    } finally {
      window.removeEventListener(REPEAT_ANCHOR_NAV_EVENT, repeat);
    }
  });
});
