import { afterEach, describe, expect, test } from 'vitest';
import {
  documentScrollports,
  FULL_PAGE_CM_HOST_SELECTORS,
  isPinnedToEnd,
  SCROLL_PIN_SLACK_PX,
} from './document-scrollports';

function buildEditorTree(): {
  outer: HTMLElement;
  conflictScroller: HTMLElement;
  hostScrollers: Record<keyof typeof FULL_PAGE_CM_HOST_SELECTORS, HTMLElement>;
  codeBlockScroller: HTMLElement;
} {
  const container = document.createElement('div');

  const outer = document.createElement('div');
  outer.className = 'editor-doc-scroll';
  container.appendChild(outer);

  const makeHost = (selector: string) => {
    const host = document.createElement('div');
    if (selector.startsWith('[')) host.setAttribute(selector.slice(1, -1), '');
    else host.className = selector.slice(1);
    const scroller = document.createElement('div');
    scroller.className = 'cm-scroller';
    host.appendChild(scroller);
    outer.appendChild(host);
    return scroller;
  };

  const hostScrollers = {
    mermaidDocEditor: makeHost(FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor),
    sourceEditor: makeHost(FULL_PAGE_CM_HOST_SELECTORS.sourceEditor),
    textDocEditor: makeHost(FULL_PAGE_CM_HOST_SELECTORS.textDocEditor),
  };

  const conflictScroller = document.createElement('div');
  conflictScroller.className = 'conflict-view';
  outer.appendChild(conflictScroller);

  const codeBlock = document.createElement('div');
  codeBlock.className = 'node-codeBlock';
  const codeBlockScroller = document.createElement('div');
  codeBlockScroller.className = 'cm-scroller';
  codeBlock.appendChild(codeBlockScroller);
  outer.appendChild(codeBlock);

  document.body.appendChild(container);
  return { outer, conflictScroller, hostScrollers, codeBlockScroller };
}

function withGeometry(scrollHeight: number, clientHeight: number, scrollTop: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('documentScrollports enumerates every surface that reserves the composer inset', () => {
  test('returns the outer document scroller, the conflict scroller and each scrolling host scroller', () => {
    const { outer, conflictScroller, hostScrollers } = buildEditorTree();

    const found = documentScrollports();

    expect(found).toContain(outer);
    expect(
      found,
      'the conflict surface reserves --ask-composer-height on its own overflow-y-auto scroller, ' +
        'so leaving it out buries the last hunk and its Accept/Reject controls under the card',
    ).toContain(conflictScroller);
    expect(found, 'mermaidDocEditor scrollport must be enumerated').toContain(
      hostScrollers.mermaidDocEditor,
    );
    expect(found, 'textDocEditor scrollport must be enumerated').toContain(
      hostScrollers.textDocEditor,
    );
    expect(found).toHaveLength(4);
  });

  test('leaves out the source editor scroller, which reserves the inset but never scrolls', () => {
    const { hostScrollers } = buildEditorTree();

    expect(
      documentScrollports(),
      '`.source-editor` is deliberately absent from `DOCUMENT_SCROLLPORT_SELECTORS`: it ' +
        'reserves the composer inset on its `.cm-content`, but the outer ' +
        '`.editor-doc-scroll` is what scrolls, so enumerating it would add an element ' +
        '`isPinnedToEnd` can never accept. jsdom does no layout, so this tier can only pin ' +
        'the selector-list decision. The layout premise behind it is owned by the ' +
        '`markdown in source mode` case in tests/stress/composer-growth-eof-reveal.e2e.ts, ' +
        'which measures the real geometry',
    ).not.toContain(hostScrollers.sourceEditor);
  });

  test('ignores a CodeMirror scroller that belongs to no registered host', () => {
    const { codeBlockScroller } = buildEditorTree();

    expect(documentScrollports()).not.toContain(codeBlockScroller);
  });

  test('returns an element matching two selectors exactly once', () => {
    const host = document.createElement('div');
    host.setAttribute('data-text-doc-editor', '');
    const scroller = document.createElement('div');
    scroller.className = 'cm-scroller editor-doc-scroll';
    host.appendChild(scroller);
    document.body.appendChild(host);

    expect(documentScrollports().filter((el) => el === scroller)).toHaveLength(1);
  });
});

describe('isPinnedToEnd decides which scrollports the composer may re-clamp', () => {
  test.each([
    ['resting exactly at its scroll end', 1000, 600, 400, true],
    ['parked inside the slack above the end', 1000, 600, 400 - (SCROLL_PIN_SLACK_PX - 1), true],
    ['parked exactly at the far edge of the slack', 1000, 600, 400 - SCROLL_PIN_SLACK_PX, true],
    ['parked one pixel above the slack', 1000, 600, 400 - (SCROLL_PIN_SLACK_PX + 1), false],
    ['reading the middle of a long document', 1000, 600, 0, false],
    ['unable to scroll at all', 600, 600, 0, false],
  ] as const)('%s', (_label, scrollHeight, clientHeight, scrollTop, expected) => {
    expect(isPinnedToEnd(withGeometry(scrollHeight, clientHeight, scrollTop))).toBe(expected);
  });
});
