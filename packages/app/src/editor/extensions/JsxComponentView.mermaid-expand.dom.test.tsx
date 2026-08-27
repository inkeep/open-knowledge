/**
 * The Expand button on a Mermaid fence's chrome bar, and the lightbox it
 * opens. Sister harness to `JsxComponentView.ask-ai.dom.test.tsx`: mocked
 * NodeViewProps around the real view, asked through the DOM.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NodeViewProps } from '@tiptap/react';
import { afterEach, describe, expect, test } from 'vitest';

afterEach(() => {
  cleanup();
});

interface Overrides {
  componentName?: string;
  chart?: string;
}

function makeProps({ componentName = 'MermaidFence', chart = 'graph TD;' }: Overrides = {}) {
  const propName = componentName === 'MermaidFence' ? 'chart' : 'formula';
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

    // The chart coming back must not resurrect the dialog unbidden.
    rerender(<JsxComponentView {...makeProps({ chart: 'graph TD; A-->B;' })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
