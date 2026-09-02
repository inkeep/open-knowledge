import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const nodeSelections: number[] = [];
let starts = 0;
let embedded = false;

vi.mock('@/hooks/use-is-embedded', () => ({
  useIsEmbedded: () => embedded,
}));

vi.mock('@/comments/store', () => ({
  emitStartComment: () => {
    starts += 1;
  },
  subscribeStartComment: () => () => {},
}));

beforeEach(() => {
  nodeSelections.length = 0;
  starts = 0;
  embedded = false;
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

interface Overrides {
  setNodeSelectionThrows?: 'type-error';
  contentSize?: number;
  freshlyInserted?: boolean;
  noPos?: boolean;
}

function makeProps({
  setNodeSelectionThrows,
  contentSize = 0,
  noPos = false,
  freshlyInserted = false,
}: Overrides = {}) {
  return {
    editor: {
      isEditable: true,
      isDestroyed: false,
      commands: {
        setNodeSelection: (p: number) => {
          if (setNodeSelectionThrows === 'type-error') {
            throw new TypeError("Cannot read properties of null (reading 'nodeSize')");
          }
          nodeSelections.push(p);
        },
      },
      state: { doc: { resolve: () => ({ depth: 0 }) }, selection: { from: 0, to: 0 } },
      on: () => {},
      off: () => {},
    },
    node: {
      type: { name: 'jsxComponent' },
      attrs: {
        componentName: 'MermaidFence',
        kind: 'element',
        attributes: [{ type: 'mdxJsxAttribute', name: 'chart', value: 'graph TD;' }],
        props: freshlyInserted ? { chart: '' } : { chart: 'graph TD;' },
        sourceRaw: freshlyInserted ? '' : '```mermaid\ngraph TD;\n```',
        sourceDirty: freshlyInserted,
      },
      content: { size: contentSize },
      nodeSize: 2,
    },
    getPos: noPos ? undefined : () => 5,
    selected: true,
    updateAttributes: () => {},
    deleteNode: () => {},
    decorations: [],
    extension: { options: {} },
    view: {},
  } as unknown as NodeViewProps;
}

async function mount(props: NodeViewProps): Promise<HTMLButtonElement | null> {
  const { JsxComponentView } = await import('./JsxComponentView.tsx');
  render(<JsxComponentView {...props} />);
  return document.querySelector<HTMLButtonElement>('[data-testid="jsx-component-ask-ai-btn"]');
}

describe('the chrome bar Ask AI button', () => {
  test('selects the block and opens the composer', async () => {
    const btn = await mount(makeProps());
    expect(btn).toBeTruthy();
    fireEvent.click(btn as HTMLButtonElement);

    await waitFor(() => expect(starts).toBe(1));
    expect(nodeSelections).toEqual([5]);
  });

  test('is absent on a component that HAS children', async () => {
    expect(await mount(makeProps({ contentSize: 4 }))).toBeNull();
  });

  test('is absent without a resolvable position', async () => {
    expect(await mount(makeProps({ noPos: true }))).toBeNull();
  });

  test('is absent while there is nothing yet to quote', async () => {
    expect(await mount(makeProps({ freshlyInserted: true }))).toBeNull();
  });

  test('is absent inside a host agent, where the comment queue is unreachable', async () => {
    embedded = true;
    expect(await mount(makeProps())).toBeNull();
  });

  test('a stale position is logged, not thrown, and opens no composer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const btn = await mount(makeProps({ setNodeSelectionThrows: 'type-error' }));
    expect(btn).toBeTruthy();

    expect(() => fireEvent.click(btn as HTMLButtonElement)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('jsx-component-chrome-ask-ai-failed');
    expect(nodeSelections).toEqual([]);
    expect(starts).toBe(0);
  });
});
