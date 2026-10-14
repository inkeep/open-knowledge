import { act, cleanup, render } from '@testing-library/react';
import { Group, Panel, Separator, useGroupRef } from 'react-resizable-panels';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { computeEditorHiddenLayout } from './editor-area-hidden-editor';

let originalOffsetWidth: PropertyDescriptor | undefined;
let originalOffsetHeight: PropertyDescriptor | undefined;
let originalResizeObserver: typeof ResizeObserver | undefined;

class InertResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setResizeObserver(value: typeof ResizeObserver | undefined) {
  for (const scope of [globalThis, document.defaultView].filter((s) => s != null)) {
    Object.defineProperty(scope, 'ResizeObserver', { value, configurable: true, writable: true });
  }
}

const ROW_PX = 1200;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
  setResizeObserver(InertResizeObserver);
  originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-mock-width') ?? 0);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.getAttribute('data-mock-height') ?? 0);
    },
  });
});

afterEach(() => {
  cleanup();
  setResizeObserver(originalResizeObserver);
  for (const [key, descriptor] of [
    ['offsetWidth', originalOffsetWidth],
    ['offsetHeight', originalOffsetHeight],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

let rowRef: ReturnType<typeof useGroupRef> | null = null;

function OuterRow({ editorVisible }: { editorVisible: boolean }) {
  const row = useGroupRef();
  rowRef = row;
  return (
    <Group orientation="horizontal" groupRef={row} data-mock-width={ROW_PX}>
      <Panel id="editor" minSize={editorVisible ? '5%' : '0%'} data-mock-width={800} />
      <Separator />
      <Panel
        id="terminal-column"
        minSize="0px"
        maxSize="0px"
        collapsible
        collapsedSize={0}
        data-mock-width={0}
      />
      <Separator />
      <Panel
        id="agents-column"
        minSize="0px"
        maxSize={editorVisible ? '95%' : '100%'}
        defaultSize="400px"
        collapsible
        collapsedSize={0}
        data-mock-width={400}
      />
    </Group>
  );
}

function BottomSplit({ editorVisible }: { editorVisible: boolean }) {
  const split = useGroupRef();
  rowRef = split;
  return (
    <Group orientation="vertical" groupRef={split} data-mock-height={800}>
      <Panel id="editor-card" minSize={editorVisible ? '5%' : '0%'} data-mock-height={560} />
      <Separator />
      <Panel
        id="terminal-dock-panel"
        minSize="120px"
        maxSize={editorVisible ? '95%' : '100%'}
        defaultSize="240px"
        collapsible
        collapsedSize={0}
        data-mock-height={240}
      />
    </Group>
  );
}

function currentRow() {
  if (rowRef?.current == null) throw new Error('the row is not mounted');
  return rowRef.current;
}

async function mount(ui: Parameters<typeof render>[0]) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(ui);
  });
  if (result == null) throw new Error('render did not return');
  const mounted = result;
  return {
    rerender: async (next: Parameters<typeof render>[0]) => {
      await act(async () => {
        mounted.rerender(next);
      });
    },
  };
}

function writeHiddenPlan() {
  const row = currentRow();
  const target = computeEditorHiddenLayout({
    currentLayout: row.getLayout(),
    editorColumnId: 'editor',
    visibleColumnPx: { 'agents-column': 400 },
  });
  act(() => {
    row.setLayout(target);
  });
  return row.getLayout();
}

describe('the resize library accepts the hidden-editor plan only under the hidden limits', () => {
  test('with today’s limits the editor column stops at 5% and chat at 95%', async () => {
    await mount(<OuterRow editorVisible />);
    const landed = writeHiddenPlan();
    expect(landed.editor).toBeCloseTo(5);
    expect(landed['agents-column']).toBeCloseTo(95);
  });

  test('with the hidden limits chat takes the whole row and the editor column reaches zero', async () => {
    const { rerender } = await mount(<OuterRow editorVisible />);
    await rerender(<OuterRow editorVisible={false} />);
    const landed = writeHiddenPlan();
    expect(landed.editor).toBeCloseTo(0);
    expect(landed['agents-column']).toBeCloseTo(100);
  });

  test('the bottom terminal can take the whole column once the editor card may reach zero', async () => {
    const { rerender } = await mount(<BottomSplit editorVisible />);
    await rerender(<BottomSplit editorVisible={false} />);
    const split = currentRow();
    act(() => {
      split.setLayout({ 'editor-card': 0, 'terminal-dock-panel': 100 });
    });
    expect(split.getLayout()['terminal-dock-panel']).toBeCloseTo(100);
    expect(split.getLayout()['editor-card']).toBeCloseTo(0);
  });

  test('restoring the shown limits lifts the editor column to its floor, and a write in the group’s key order lands', async () => {
    const { rerender } = await mount(<OuterRow editorVisible />);
    await rerender(<OuterRow editorVisible={false} />);
    writeHiddenPlan();
    await rerender(<OuterRow editorVisible />);
    const row = currentRow();
    expect(row.getLayout().editor).toBeCloseTo(5);
    const shown: Record<string, number> = { editor: 60, 'terminal-column': 0, 'agents-column': 40 };
    const inGroupOrder = Object.fromEntries(
      Object.keys(row.getLayout()).map((id) => [id, shown[id] ?? 0]),
    );
    act(() => {
      row.setLayout(inGroupOrder);
    });
    expect(row.getLayout().editor).toBeCloseTo(60);
    expect(row.getLayout()['agents-column']).toBeCloseTo(40);
  });
});
