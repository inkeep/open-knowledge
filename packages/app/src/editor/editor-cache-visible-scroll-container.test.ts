// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { visibleEditorScrollContainer } from './editor-cache.ts';

/**
 * jsdom has no layout engine, so `getClientRects()` is empty for every element.
 * Stub it to model the real browser signal the helper relies on: a painted
 * element has layout boxes, a `display:none` (hidden `<Activity>`) element has
 * none. This stubs the missing platform capability, not the module under test.
 */
function addScrollContainer(painted: boolean, scrollTop: number): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute('data-testid', 'editor-scroll-container');
  el.scrollTop = scrollTop;
  el.getClientRects = () =>
    (painted ? [{ width: 800, height: 600 } as DOMRect] : []) as unknown as DOMRectList;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('visibleEditorScrollContainer', () => {
  test('picks the painted container even when a hidden pooled one precedes it in DOM order', () => {
    // A hidden pooled entry's container survives in the DOM and sorts first; a
    // plain first-match query would return it and read its stale scrollTop.
    addScrollContainer(false, 111);
    const active = addScrollContainer(true, 222);
    expect(visibleEditorScrollContainer()).toBe(active);
    expect(visibleEditorScrollContainer()?.scrollTop).toBe(222);
  });

  test('returns null when no container is painted', () => {
    addScrollContainer(false, 1);
    addScrollContainer(false, 2);
    expect(visibleEditorScrollContainer()).toBeNull();
  });

  test('returns the sole container when nothing is pooled', () => {
    const only = addScrollContainer(true, 42);
    expect(visibleEditorScrollContainer()).toBe(only);
  });
});
