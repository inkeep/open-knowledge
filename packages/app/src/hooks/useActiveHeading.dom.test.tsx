import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { useActiveHeading } from './useActiveHeading';

const MID_Y = window.innerHeight / 2;

interface Fixture {
  slugs: string[];
  scrollport: HTMLElement;
  setTop: (slug: string, top: number) => void;
}

function mountHeadings(tops: Array<[slug: string, top: number]>): Fixture {
  const scrollport = document.createElement('div');
  document.body.append(scrollport);
  for (const [slug, top] of tops) {
    const el = document.createElement('h2');
    el.id = slug;
    el.textContent = slug;
    scrollport.append(el);
    setRectTop(el, top);
  }
  return {
    slugs: tops.map(([slug]) => slug),
    scrollport,
    setTop: (slug, top) => {
      const el = document.getElementById(slug);
      if (el) setRectTop(el, top);
    },
  };
}

function setRectTop(el: HTMLElement, top: number) {
  el.getBoundingClientRect = () => ({ top, height: 30, bottom: top + 30 }) as DOMRect;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('useActiveHeading (WYSIWYG geometry)', () => {
  test('picks the first heading visible in the top half of the viewport', () => {
    const { slugs } = mountHeadings([
      ['alpha', -400],
      ['beta', MID_Y - 50],
      ['gamma', MID_Y - 10],
      ['delta', MID_Y + 500],
    ]);

    const { result } = renderHook(() => useActiveHeading(slugs));

    expect(result.current).toBe('beta');
  });

  test('falls back to the last heading scrolled above the viewport when none is in the top half', () => {
    const { slugs } = mountHeadings([
      ['alpha', -900],
      ['beta', -300],
      ['gamma', MID_Y + 100],
      ['delta', MID_Y + 700],
    ]);

    const { result } = renderHook(() => useActiveHeading(slugs));

    expect(result.current).toBe('beta');
  });

  test('falls back to the first heading when the reader is above every heading', () => {
    const { slugs } = mountHeadings([
      ['alpha', MID_Y + 40],
      ['beta', MID_Y + 400],
    ]);

    const { result } = renderHook(() => useActiveHeading(slugs));

    expect(result.current).toBe('alpha');
  });

  test('reports no active heading when the document has no headings', () => {
    const { result } = renderHook(() => useActiveHeading([]));

    expect(result.current).toBeUndefined();
  });

  test('skips slugs with no corresponding element', () => {
    const { slugs } = mountHeadings([
      ['alpha', -200],
      ['gamma', MID_Y + 900],
    ]);

    const { result } = renderHook(() => useActiveHeading([slugs[0], 'never-rendered', slugs[1]]));

    expect(result.current).toBe('alpha');
  });

  test('re-measures on a scroll event from a nested scroll container', async () => {
    const { slugs, scrollport, setTop } = mountHeadings([
      ['alpha', MID_Y - 20],
      ['beta', MID_Y + 600],
      ['gamma', MID_Y + 1200],
    ]);

    const { result } = renderHook(() => useActiveHeading(slugs));
    expect(result.current).toBe('alpha');

    setTop('alpha', -500);
    setTop('beta', MID_Y - 20);
    setTop('gamma', MID_Y + 600);
    act(() => {
      scrollport.dispatchEvent(new Event('scroll'));
    });

    await waitFor(() => {
      expect(result.current).toBe('beta');
    });
  });
});
