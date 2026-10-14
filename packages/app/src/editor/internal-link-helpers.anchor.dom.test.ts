import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
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
  vi.restoreAllMocks();
});

function mountHeading(id: string): ReturnType<typeof vi.fn> {
  const heading = document.createElement('h2');
  heading.id = id;
  const scrollIntoView = vi.fn();
  heading.scrollIntoView = scrollIntoView;
  document.body.append(heading);
  return scrollIntoView;
}

describe('navigateToMarkdownTarget — in-document anchors', () => {
  test('scrolls to the heading whose id is the anchor', () => {
    const scrollIntoView = mountHeading('install');
    navigateToMarkdownTarget({ kind: 'anchor', anchor: 'install' }, '#/docs/guide');
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  test('scrolls to a Korean heading from an anchor saved as decomposed jamo', () => {
    const scrollIntoView = mountHeading('한국어');
    navigateToMarkdownTarget({ kind: 'anchor', anchor: '한국어'.normalize('NFD') }, '#/docs/guide');
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });
});
