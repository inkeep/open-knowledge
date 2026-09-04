import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __resetScrollRestoreCoordination,
  isScrollRestoreSuppressed,
  registerLandingScrollOwner,
} from '@/editor/scroll-restore-coordination';
import { scrollAnchorIntoView } from './scroll-to-anchor';

const DOC = 'recipes/stir-fry';

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
      suppressedAtWriteTime = isScrollRestoreSuppressed(DOC);
      scrollTo(options as ScrollToOptions);
    };

    expect(scrollAnchorIntoView(editor, { from: 1, to: 5 }, DOC)).toBe(true);
    expect(suppressedAtWriteTime).toBe(true);
    expect(isScrollRestoreSuppressed(DOC)).toBe(true);

    vi.advanceTimersByTime(1_000);
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
    expect(isScrollRestoreSuppressed(DOC)).toBe(false);
  });
});
