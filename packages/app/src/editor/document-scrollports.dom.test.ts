import { afterEach, describe, expect, test } from 'vitest';
import {
  DOCUMENT_SCROLLPORT_SELECTORS,
  documentScrollports,
  FULL_PAGE_CM_HOST_SELECTORS,
  FULL_PAGE_CM_SCROLLPORTS,
  type FullPageCmHost,
  isPinnedToEnd,
  SCROLL_PIN_SLACK_PX,
} from './document-scrollports';

const FULL_PAGE_CM_HOSTS = Object.keys(FULL_PAGE_CM_HOST_SELECTORS) as FullPageCmHost[];

function buildEditorTree(): {
  outer: HTMLElement;
  conflictScroller: HTMLElement;
  hostScrollers: Record<FullPageCmHost, HTMLElement>;
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

describe('FULL_PAGE_CM_SCROLLPORTS names the element each full-page CodeMirror host actually scrolls', () => {
  test('every registered full-page CodeMirror host has a scrollport entry', () => {
    expect(
      Object.keys(FULL_PAGE_CM_SCROLLPORTS).sort(),
      'a host registered in FULL_PAGE_CM_HOST_SELECTORS with no scrollport entry is a surface the ' +
        'composer can paint over and never scroll, which is the whole shape of this bug',
    ).toEqual([...FULL_PAGE_CM_HOSTS].sort());
  });

  test('every scrollport entry is one of the selectors documentScrollports already queries', () => {
    expect(
      DOCUMENT_SCROLLPORT_SELECTORS,
      'the caret reveal must scroll an element that also reserves the composer inset. A scrollport ' +
        'outside this list reserves no inset, so scrolling it puts the caret line under the card again',
    ).toEqual(expect.arrayContaining(Object.values(FULL_PAGE_CM_SCROLLPORTS)));
  });

  test.each(FULL_PAGE_CM_HOSTS)(
    'the %s scrollport resolves from that host cm-scroller onto an enumerated scrollport',
    (host) => {
      const { hostScrollers } = buildEditorTree();

      const resolved = hostScrollers[host].closest(FULL_PAGE_CM_SCROLLPORTS[host]);

      expect(
        resolved,
        `\`FULL_PAGE_CM_SCROLLPORTS.${host}\` must resolve from this host own \`scrollDOM\` via ` +
          '`closest`. Resolving to nothing leaves the reveal with no element to scroll',
      ).not.toBeNull();
      expect(documentScrollports()).toContain(resolved);
    },
  );

  test('markdown source mode falls through its own non-scrolling cm-scroller to the outer document scroller', () => {
    const { outer, hostScrollers } = buildEditorTree();

    const resolved = hostScrollers.sourceEditor.closest(FULL_PAGE_CM_SCROLLPORTS.sourceEditor);

    expect(
      resolved,
      'the source editor `.cm-scroller` reserves the composer inset on its `.cm-content` but never ' +
        'scrolls: the outer `.editor-doc-scroll` does. This host is why the table names a ' +
        'scrollport per host instead of assuming every full-page CodeMirror scrolls itself',
    ).toBe(outer);
    expect(resolved).not.toBe(hostScrollers.sourceEditor);
  });

  test.each(['textDocEditor', 'mermaidDocEditor'] as const)(
    'the %s host resolves to its own cm-scroller, not to the outer document scroller',
    (host) => {
      const { outer, hostScrollers } = buildEditorTree();

      const resolved = hostScrollers[host].closest(FULL_PAGE_CM_SCROLLPORTS[host]);

      expect(resolved).toBe(hostScrollers[host]);
      expect(
        resolved,
        `\`${host}\` scrolls itself. Resolving it to the outer document scroller would scroll an ` +
          'element that is not moving under the caret',
      ).not.toBe(outer);
    },
  );
});
