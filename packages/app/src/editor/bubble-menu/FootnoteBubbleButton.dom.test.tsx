/**
 * DOM tests for `FootnoteBubbleButton`'s gating predicates — these guard
 * against two regressions that would silently corrupt user content:
 *
 *   1. `selectionContainsFootnoteRef` prevents the `[^[^N]]` nesting bug
 *      (wrapping a `footnoteReference` atom inside another reference would
 *      emit malformed GFM that breaks markdown round-trip).
 *   2. `hasFootnoteSchema` prevents a TipTap dispatch crash on stripped
 *      schemas where the footnote nodes are absent (e.g. read-only preview
 *      surfaces, future minimal-feature builds).
 *
 * Both predicates drive the `disabled` attribute on the rendered button —
 * tested through DOM observation rather than internal call patterns so the
 * tests survive refactors that preserve the behavioral contract.
 *
 * Repo convention (see `EditWithAiBubbleButton.dom.test.tsx`,
 * `ActivityPanelBurstRow.test.tsx`): no @testing-library/react interaction
 * helpers — assert through queries on the rendered DOM after `render`.
 */

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

/**
 * Minimal Editor stub satisfying every property the button reads:
 *   - `schema.nodes` for `hasFootnoteSchema`
 *   - `state.selection.empty` + `.$from`/`.$to` for the cross-block guard
 *   - `state.doc.nodesBetween` for `selectionContainsFootnoteRef`
 *   - The Tiptap React `useEditorState` hook subscribes via `on`/`off` —
 *     we no-op the listener; the selector runs synchronously on first
 *     mount which is the only state we care about asserting.
 */
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
