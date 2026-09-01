import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('../components/live-doc-pool.ts', () => ({
  useLiveDocText: () => ({ kind: 'ready', text: '{"elements":[]}' }),
  LIVE_DOC_POOL_MAX: 30,
}));
vi.doMock('@excalidraw/excalidraw', () => ({
  exportToSvg: async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
  restore: (data: unknown) => ({
    elements: (data as { elements?: unknown[] })?.elements ?? [],
    appState: {},
    files: {},
  }),
}));

let blobUrlCounter = 0;
URL.createObjectURL = () => `blob:mock-${++blobUrlCounter}`;
URL.revokeObjectURL = () => {};

afterEach(() => {
  cleanup();
});

interface Overrides {
  componentName?: string;
  chart?: string;
}

function makeProps({ componentName = 'MermaidFence', chart = 'graph TD;' }: Overrides = {}) {
  const propName =
    componentName === 'MermaidFence' ? 'chart' : componentName === 'Excalidraw' ? 'src' : 'formula';
  return {
    editor: {
      isEditable: true,
      isDestroyed: false,
      commands: { setNodeSelection: () => {} },
      state: { doc: { resolve: () => ({ depth: 0 }) }, selection: { from: 0, to: 0 } },
      on: () => {},
      off: () => {},
    },
    node: {
      type: { name: 'jsxComponent' },
      attrs: {
        componentName,
        kind: 'element',
        attributes: [{ type: 'mdxJsxAttribute', name: propName, value: chart }],
        props: { [propName]: chart },
        sourceRaw: '',
        sourceDirty: false,
      },
      content: { size: 0 },
      nodeSize: 2,
    },
    getPos: () => 5,
    selected: true,
    updateAttributes: () => {},
    deleteNode: () => {},
    decorations: [],
    extension: { options: {} },
    view: {},
  } as unknown as NodeViewProps;
}

async function mount(props: NodeViewProps) {
  const { JsxComponentView } = await import('./JsxComponentView.tsx');
  return render(<JsxComponentView {...props} />);
}

const expandBtn = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="jsx-component-expand-btn"]');

describe('the chrome bar Expand button', () => {
  test('opens the lightbox over the block chart', async () => {
    await mount(makeProps({ chart: 'graph TD; A-->B;' }));
    const btn = expandBtn();
    expect(btn).toBeTruthy();

    fireEvent.click(btn as HTMLButtonElement);

    expect(await screen.findByRole('dialog', { name: 'Mermaid diagram' })).not.toBeNull();
  });

  test('is absent while the chart is empty or whitespace', async () => {
    await mount(makeProps({ chart: '   ' }));
    expect(expandBtn()).toBeNull();
  });

  test('is absent on a non-Mermaid source-bearing component', async () => {
    await mount(makeProps({ componentName: 'MathFence', chart: 'x^2' }));
    expect(expandBtn()).toBeNull();
  });

  test('an emptied chart closes the lightbox and it stays closed when the chart returns', async () => {
    const { rerender } = await mount(makeProps({ chart: 'graph TD; A-->B;' }));
    fireEvent.click(expandBtn() as HTMLButtonElement);
    await screen.findByRole('dialog', { name: 'Mermaid diagram' });

    const { JsxComponentView } = await import('./JsxComponentView.tsx');
    rerender(<JsxComponentView {...makeProps({ chart: '' })} />);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    rerender(<JsxComponentView {...makeProps({ chart: 'graph TD; A-->B;' })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

const boardExpandBtn = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="jsx-component-expand-board-btn"]');

describe('the chrome bar Expand button for Excalidraw blocks', () => {
  test('opens the embed lightbox for a referenced board', async () => {
    await mount(makeProps({ componentName: 'Excalidraw', chart: 'demo/board.excalidraw' }));
    const btn = boardExpandBtn();
    expect(btn).toBeTruthy();
    const card = document.querySelector('.excalidraw-embed');
    expect(card).not.toBeNull();
    expect(card?.contains(btn)).toBe(false);
    const cardExpandButtons = Array.from(card?.querySelectorAll('button') ?? []).filter((b) =>
      /expand/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`),
    );
    expect(cardExpandButtons).toEqual([]);
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="excalidraw-embed-snapshot"] img'),
      ).not.toBeNull();
    });

    fireEvent.click(btn as HTMLButtonElement);

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
  });

  test('is absent while the board reference is empty', async () => {
    await mount(makeProps({ componentName: 'Excalidraw', chart: '   ' }));
    expect(boardExpandBtn()).toBeNull();
  });
});
