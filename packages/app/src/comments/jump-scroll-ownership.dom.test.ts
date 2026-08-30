/**
 * A comment jump has to be the document's single scroll writer while it lands.
 *
 * The regression: the pool's scroll-restore loop only treats a scrollTop
 * INCREASE as someone else taking over. A decrease is indistinguishable from the
 * browser's shrink-clamp, so it re-applies its own target over one — and a jump
 * to a comment ABOVE the current view is exactly a decrease. Click after click
 * did nothing until the loop's ten-second backstop expired, which reads as
 * "it works after five or six taps".
 *
 * `acquireScrollRestoreSuppression` is the channel the loop actually watches (it
 * exits on the next frame, naming whichever holder raised it), so what this pins
 * is that the jump holds it ACROSS the write and lets go afterwards.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetScrollRestoreCoordination,
  isScrollRestoreSuppressed,
  registerLandingScrollOwner,
} from '@/editor/scroll-restore-coordination';
import { scrollAnchorIntoView } from './scroll-to-anchor';

const DOC = 'recipes/stir-fry';

/**
 * An editor whose scroll container reports the passage far ABOVE the viewport —
 * the direction the restore loop refuses to yield to on its own.
 */
function editorWithAnchorAbove() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollHeight', { value: 10_000 });
  Object.defineProperty(container, 'clientHeight', { value: 800 });
  container.style.overflowY = 'auto';
  container.scrollTop = 5_000;
  container.getBoundingClientRect = () => ({ top: 0, bottom: 800 }) as DOMRect;
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === 'object' && options?.top !== undefined)
      container.scrollTop = options.top;
  };

  const dom = document.createElement('div');
  container.appendChild(dom);
  document.body.appendChild(container);

  const view = {
    dom,
    // Above the scrollport: a jump here DECREASES scrollTop.
    coordsAtPos: () => ({ top: -400, bottom: -380 }),
  };
  return { editor: { editorView: view } as never, container };
}

beforeEach(() => {
  __resetScrollRestoreCoordination();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
  __resetScrollRestoreCoordination();
});

describe('a comment jump', () => {
  test('owns the scroller across the write, then lets go', () => {
    const { editor, container } = editorWithAnchorAbove();
    let suppressedAtWriteTime = false;
    const scrollTo = container.scrollTo.bind(container);
    container.scrollTo = (options?: ScrollToOptions | number) => {
      // The flag has to be up BEFORE the scroller moves — the restore loop
      // measures on the same frame, and a move it sees first reads as drift.
      suppressedAtWriteTime = isScrollRestoreSuppressed(DOC);
      scrollTo(options as ScrollToOptions);
    };

    expect(scrollAnchorIntoView(editor, { from: 1, to: 5 }, DOC)).toBe(true);
    expect(suppressedAtWriteTime).toBe(true);
    // Held past the write so the loop gets a frame to see it.
    expect(isScrollRestoreSuppressed(DOC)).toBe(true);

    vi.advanceTimersByTime(1_000);
    // Released: the flag also gates the agent-follow scroll and the composer's
    // bottom pin, so a jump must not hold it indefinitely.
    expect(isScrollRestoreSuppressed(DOC)).toBe(false);
  });

  test('declines rather than fighting a landing that does not yield', () => {
    const { editor, container } = editorWithAnchorAbove();
    const before = container.scrollTop;
    registerLandingScrollOwner(DOC, {
      yieldsToNavigation: false,
      supersede: () => {},
    });

    expect(scrollAnchorIntoView(editor, { from: 1, to: 5 }, DOC)).toBe(false);
    expect(container.scrollTop).toBe(before);
    // Nothing acquired for a scroll that never happened.
    expect(isScrollRestoreSuppressed(DOC)).toBe(false);
  });
});
