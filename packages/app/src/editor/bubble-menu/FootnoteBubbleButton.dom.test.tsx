import { describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FootnoteBubbleButton } from './FootnoteBubbleButton';

interface FakeEditorOpts {
  hasSchema?: boolean;
  emptySelection?: boolean;
  selectionContainsRef?: boolean;
  selectionCrossesBlocks?: boolean;
}

function makeEditor(opts: FakeEditorOpts = {}): Editor {
  const {
    hasSchema = true,
    emptySelection = false,
    selectionContainsRef = false,
    selectionCrossesBlocks = false,
  } = opts;

  const nodes: Record<string, unknown> = {};
  if (hasSchema) {
    nodes.footnoteReference = {};
    nodes.footnoteDefinition = {};
  }

  const parentA = { someParentToken: 'A' };
  const parentB = { someParentToken: 'B' };

  const selection = {
    empty: emptySelection,
    from: 5,
    to: 10,
    $from: { sameParent: (other: { someParentToken: string }) => other === parentA },
    $to: selectionCrossesBlocks ? parentB : parentA,
  };

  const doc = {
    nodesBetween: (
      _from: number,
      _to: number,
      cb: (node: { type: { name: string } }) => boolean | undefined,
    ) => {
      if (selectionContainsRef) {
        cb({ type: { name: 'footnoteReference' } });
      } else {
        cb({ type: { name: 'text' } });
      }
    },
  };

  return {
    schema: { nodes },
    state: { selection, doc },
    on: () => {},
    off: () => {},
  } as unknown as Editor;
}

function renderWithProvider(editor: Editor) {
  return render(
    <TooltipProvider>
      <FootnoteBubbleButton editor={editor} />
    </TooltipProvider>,
  );
}

function findButton(container: HTMLElement): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="footnote-bubble-button"]');
  if (!btn) throw new Error('button not rendered');
  return btn;
}

describe('FootnoteBubbleButton — disabled gating', () => {
  test('disabled when schema lacks footnoteReference / footnoteDefinition', () => {
    const { container } = renderWithProvider(makeEditor({ hasSchema: false }));
    expect(findButton(container).disabled).toBe(true);
    cleanup();
  });

  test('disabled when selection is empty', () => {
    const { container } = renderWithProvider(makeEditor({ emptySelection: true }));
    expect(findButton(container).disabled).toBe(true);
    cleanup();
  });

  test('disabled when selection spans an existing footnoteReference atom', () => {
    const { container } = renderWithProvider(makeEditor({ selectionContainsRef: true }));
    expect(findButton(container).disabled).toBe(true);
    cleanup();
  });

  test('disabled when selection crosses textblock boundaries', () => {
    const { container } = renderWithProvider(makeEditor({ selectionCrossesBlocks: true }));
    expect(findButton(container).disabled).toBe(true);
    cleanup();
  });

  test('enabled when schema present + non-empty single-block selection without refs', () => {
    const { container } = renderWithProvider(makeEditor());
    expect(findButton(container).disabled).toBe(false);
    cleanup();
  });
});
