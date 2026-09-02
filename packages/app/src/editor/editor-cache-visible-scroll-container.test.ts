// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { visibleEditorScrollContainer } from './editor-cache.ts';

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
