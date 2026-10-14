import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { computeInnerFollowLayout } from './editor-area-inner-follow';

type Observation = {
  readonly callback: ResizeObserverCallback;
  readonly observer: ResizeObserver;
  readonly target: Element;
};

let observations: Observation[] = [];
let originalResizeObserver: typeof ResizeObserver | undefined;
let originalOffsetWidth: PropertyDescriptor | undefined;

class CapturingResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    observations.push({ callback: this.callback, observer: this, target });
  }
  unobserve() {}
  disconnect() {}
}

const OUTER_PX = 1400;
const TERMINAL_PX = 300;
const CHAT_PX = 400;
const EDITOR_PX = OUTER_PX - TERMINAL_PX - CHAT_PX;
const DOC_PX = 320;
const WORKSPACE_PX = EDITOR_PX - DOC_PX;

beforeEach(() => {
  observations = [];
  originalResizeObserver = globalThis.ResizeObserver;
  const install = (scope: object) => {
    Object.defineProperty(scope, 'ResizeObserver', {
      value: CapturingResizeObserver,
      configurable: true,
      writable: true,
    });
  };
  install(globalThis);
  if (document.defaultView != null) install(document.defaultView);
  originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-mock-width') ?? 0);
    },
  });
});

afterEach(() => {
  cleanup();
  const restore = (scope: object) => {
    Object.defineProperty(scope, 'ResizeObserver', {
      value: originalResizeObserver,
      configurable: true,
      writable: true,
    });
  };
  restore(globalThis);
  if (document.defaultView != null) restore(document.defaultView);
  if (originalOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  }
});

let outerRef: ReturnType<typeof useGroupRef> | null = null;
let innerRef: ReturnType<typeof useGroupRef> | null = null;

function EditorCardRows() {
  const outer = useGroupRef();
  const inner = useGroupRef();
  outerRef = outer;
  innerRef = inner;
  return (
    <Group orientation="horizontal" groupRef={outer}>
      <Panel id="editor" minSize="5%" data-mock-width={EDITOR_PX}>
        <Group orientation="horizontal" groupRef={inner}>
          <Panel id="workspace" minSize="5%" data-mock-width={WORKSPACE_PX} />
          <Separator />
          <Panel
            id="doc"
            minSize="300px"
            maxSize="600px"
            defaultSize={`${DOC_PX}px`}
            collapsible
            collapsedSize={0}
            data-mock-width={DOC_PX}
          />
        </Group>
      </Panel>
      <Separator />
      <Panel
        id="terminal"
        minSize={`${TERMINAL_PX}px`}
        defaultSize={`${TERMINAL_PX}px`}
        data-mock-width={TERMINAL_PX}
      />
      <Separator />
      <Panel id="chat" minSize="0px" defaultSize={`${CHAT_PX}px`} data-mock-width={CHAT_PX} />
    </Group>
  );
}

function element(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (el == null) throw new Error(`${selector} is not rendered`);
  return el;
}

function pxOf(layout: Record<string, number>, id: string, groupPx: number): number {
  return ((layout[id] ?? 0) / 100) * groupPx;
}

function pct(px: number, groupPx: number): number {
  return (px / groupPx) * 100;
}

async function layOutEditorColumn(editorPx: number) {
  element('#editor').setAttribute('data-mock-width', String(editorPx));
  element('#workspace').setAttribute('data-mock-width', String(editorPx / 2));
  element('#doc').setAttribute('data-mock-width', String(editorPx / 2));
  const innerRow = element('#doc').parentElement;
  if (innerRow == null) throw new Error('the side panel has no row');
  const observation = observations.findLast((entry) => entry.target === innerRow);
  if (observation == null) throw new Error('the inner row is not observed by the library');
  await act(async () => {
    observation.callback(
      [{ target: innerRow, borderBoxSize: [] } as unknown as ResizeObserverEntry],
      observation.observer,
    );
  });
}

describe('the side panel keeps its pixel width while an outer divider is dragged', () => {
  test.each([
    { divider: 'chat', terminalPx: TERMINAL_PX, chatPx: CHAT_PX + 150 },
    { divider: 'terminal', terminalPx: TERMINAL_PX + 100, chatPx: CHAT_PX },
    { divider: 'chat', terminalPx: TERMINAL_PX, chatPx: CHAT_PX - 120 },
  ])(
    'the $divider column taking width from the editor column leaves the side panel at its width',
    async ({ terminalPx, chatPx }) => {
      await act(async () => {
        render(<EditorCardRows />);
      });
      const outer = outerRef?.current;
      const inner = innerRef?.current;
      if (!outer || !inner) throw new Error('group imperative handles were not attached');
      expect(pxOf(inner.getLayout(), 'doc', EDITOR_PX)).toBeCloseTo(DOC_PX, 1);

      const editorPxAfterDrag = OUTER_PX - terminalPx - chatPx;
      const movedOuter = {
        ...outer.getLayout(),
        editor: pct(editorPxAfterDrag, OUTER_PX),
        terminal: pct(terminalPx, OUTER_PX),
        chat: pct(chatPx, OUTER_PX),
      };
      const follow = () =>
        inner.setLayout(
          computeInnerFollowLayout({
            outerLayout: movedOuter,
            outerResidualId: 'editor',
            outerPanelSpacePx: OUTER_PX,
            innerChromePx: 0,
            innerLayout: inner.getLayout(),
            innerResidualId: 'workspace',
            pinnedPx: { doc: DOC_PX },
          }),
        );
      await act(async () => {
        outer.setLayout(movedOuter);
        follow();
      });
      expect(pxOf(outer.getLayout(), 'editor', OUTER_PX)).toBeCloseTo(editorPxAfterDrag, 1);
      const sidePanelMinPct = pct(300, EDITOR_PX);
      const expectedFirstWritePct = Math.max(pct(DOC_PX, editorPxAfterDrag), sidePanelMinPct);
      expect(inner.getLayout().doc).toBeCloseTo(expectedFirstWritePct, 2);

      await layOutEditorColumn(editorPxAfterDrag);
      await act(async () => {
        follow();
      });

      const settled = inner.getLayout();
      expect(pxOf(settled, 'doc', editorPxAfterDrag)).toBeCloseTo(DOC_PX, 1);
      expect(pxOf(settled, 'workspace', editorPxAfterDrag)).toBeCloseTo(
        editorPxAfterDrag - DOC_PX,
        1,
      );
    },
  );

  test('a collapsed side panel stays collapsed when the editor column resizes', async () => {
    await act(async () => {
      render(<EditorCardRows />);
    });
    const inner = innerRef?.current;
    if (!inner) throw new Error('inner group imperative handle was not attached');
    await act(async () => {
      inner.setLayout({ ...inner.getLayout(), workspace: 100, doc: 0 });
    });
    expect(pxOf(inner.getLayout(), 'doc', EDITOR_PX)).toBe(0);

    await layOutEditorColumn(EDITOR_PX - 150);

    expect(pxOf(inner.getLayout(), 'doc', EDITOR_PX - 150)).toBe(0);
    expect(inner.getLayout().workspace).toBeCloseTo(100, 3);
  });

  test('a layout write must keep the group’s own key order, which the follow helper preserves', async () => {
    await act(async () => {
      render(<EditorCardRows />);
    });
    const inner = innerRef?.current;
    if (!inner) throw new Error('inner group imperative handle was not attached');
    const groupKeyOrder = Object.keys(inner.getLayout());
    const followed = computeInnerFollowLayout({
      outerLayout: { editor: 40, terminal: 20, chat: 40 },
      outerResidualId: 'editor',
      outerPanelSpacePx: OUTER_PX,
      innerChromePx: 0,
      innerLayout: inner.getLayout(),
      innerResidualId: 'workspace',
      pinnedPx: { doc: DOC_PX },
    });
    expect(Object.keys(followed)).toEqual(groupKeyOrder);

    await act(async () => {
      inner.setLayout(followed);
    });
    expect(pxOf(inner.getLayout(), 'doc', 0.4 * OUTER_PX)).toBeCloseTo(DOC_PX, 1);
  });
});
