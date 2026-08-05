/**
 * The Ask AI button on a childless component's chrome bar.
 *
 * Sister to `CodeBlockView.dom.test.tsx`'s pinned click-to-compose test, and
 * load-bearing for the same reason: this button is the ONLY route to commenting
 * on a mermaid diagram, a math block, an image or an attached file. None of
 * them has text to select, so the selection toolbar is not a way in — and for
 * an image the toolbar does open, on its alignment branch, which carries no
 * comment entry at all.
 */

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

// Each case renders its own view and then asks the DOM whether the button is
// there; without this an earlier render's button answers for a later case.
afterEach(() => {
  cleanup();
});

interface Overrides {
  /** How a stale position fails: `setNodeSelection` clamps, so this is real. */
  setNodeSelectionThrows?: 'type-error';
  /** Non-zero makes the component one WITH children. */
  contentSize?: number;
  /** A slash-inserted component: no source captured, only default props. */
  freshlyInserted?: boolean;
  /** A NodeView whose position cannot be resolved hands `getPos` as undefined. */
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
            // What ProseMirror actually raises for a position that clamped into
            // bounds but has no node after it — see the handler's comment.
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
        // `createChildNode` captures no source for a slash insertion.
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
    // The block itself is the subject — there is nothing inside to prefer.
    expect(nodeSelections).toEqual([5]);
  });

  test('is absent on a component that HAS children', async () => {
    // Its text is real content, so the selection toolbar already reaches it and
    // a second entry point here would be a second door to one room.
    expect(await mount(makeProps({ contentSize: 4 }))).toBeNull();
  });

  test('is absent without a resolvable position', async () => {
    expect(await mount(makeProps({ noPos: true }))).toBeNull();
  });

  /**
   * A slash-inserted component has no source captured and nothing but default
   * props, so there is no text to quote until the author types into it. The
   * button is gated on the same `commentLeafText` the composer reads, so it
   * cannot offer an action that would silently decline.
   */
  test('is absent while there is nothing yet to quote', async () => {
    expect(await mount(makeProps({ freshlyInserted: true }))).toBeNull();
  });

  test('is absent inside a host agent, where the comment queue is unreachable', async () => {
    // Same gate the code block's Ask AI button applies.
    embedded = true;
    expect(await mount(makeProps())).toBeNull();
  });

  /**
   * The failure this catch exists for. `setNodeSelection` clamps its argument,
   * so a stale position does not raise `RangeError` — it lands in bounds and
   * fails inside `NodeSelection.create` as a `TypeError`. Narrowing the catch to
   * `RangeError`, as the delete and move handlers correctly do for their own
   * `doc.resolve` calls, would re-throw this into `ComponentErrorBoundary` and
   * convert the block to a stuck placeholder — losing the rendered component
   * because a button missed.
   */
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
