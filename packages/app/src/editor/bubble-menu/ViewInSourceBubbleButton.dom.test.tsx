/**
 * RTL behavior tests for `ViewInSourceBubbleButton` — the WYSIWYG bubble-menu
 * "View in source" entry.
 *
 * These exercise the real `requestViewInSource` wiring end to end: the button
 * reads the doc name and Y.Doc off the editor, derives the source `Y.Text`, and
 * drives the jump. The observable effects are the real ones — the flip event
 * that `EditorPane` subscribes to, and the jump navigation banked in the shared
 * pending-navigation store — so nothing internal is mocked.
 *
 * The keyboard cases are the point of the story: the icon-only siblings in this
 * bar act on `mousedown` only and so never fire from the keyboard. This entry
 * puts its action on `onClick`, which a focused button raises from Enter and
 * Space alike, and leaves `mousedown` to only hold the selection paint.
 *
 * Invocation: `pnpm run test:dom` from `packages/app/`.
 */

import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Editor, getSchema } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setEditorDocName } from '../extensions/doc-context.ts';
import {
  clearPendingSourceNavigationsForTest,
  peekPendingSourceNavigation,
} from '../source-editor-navigation.ts';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '../view-in-source-event.ts';
import { ViewInSourceBubbleButton } from './ViewInSourceBubbleButton.tsx';

const md = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const DOC = '# Title\n\nfirst\n\ntarget paragraph';

/** PM position just inside top-level block `index`. */
function pmPosOfBlock(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + 1;
}

/**
 * A stand-in TipTap editor complete enough for the real jump: a ProseMirror
 * view carrying the caret + doc (`getEditorView`), a Collaboration extension
 * whose document is the seeded Y.Doc (`getYDoc`), and a registered doc name
 * (`getEditorDocName`). Pass `docName: null` to leave it unregistered. `caretBlock`
 * places the caret inside that top-level block, so the jump targets it.
 */
function makeEditor(
  markdown: string,
  caretBlock: number,
  docName: string | null = 'doc-view',
): { editor: Editor; ydoc: Y.Doc } {
  const { body } = stripFrontmatter(markdown);
  const doc = schema.nodeFromJSON(md.parse(body));
  const ydoc = new Y.Doc();
  ydoc.getText('source').insert(0, markdown);
  const editor = {
    isDestroyed: false,
    editorView: { state: { doc, selection: { from: pmPosOfBlock(doc, caretBlock) } } },
    extensionManager: { extensions: [{ name: 'collaboration', options: { document: ydoc } }] },
  } as unknown as Editor;
  setEditorDocName(editor, docName);
  return { editor, ydoc };
}

function renderButton(editor: Editor) {
  return render(
    <TooltipProvider>
      <ViewInSourceBubbleButton editor={editor} />
    </TooltipProvider>,
  );
}

let flipped: string[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  clearPendingSourceNavigationsForTest();
  flipped = [];
  const onFlip = (e: Event) => {
    flipped.push((e as CustomEvent<ViewInSourceDetail>).detail.docName);
  };
  window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
  unsubscribe = () => window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  cleanup();
});

describe('ViewInSourceBubbleButton', () => {
  test('renders a labelled, native-button entry', () => {
    const { editor } = makeEditor(DOC, 2);
    renderButton(editor);

    const button = screen.getByTestId('view-in-source-bubble-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('View in source markdown');
  });

  test('clicking jumps to the selection block and asks the pane to flip', async () => {
    const user = userEvent.setup();
    const { editor } = makeEditor(DOC, 2);
    renderButton(editor);

    await user.click(screen.getByTestId('view-in-source-bubble-button'));

    expect(flipped).toEqual(['doc-view']);
    const nav = peekPendingSourceNavigation('doc-view');
    if (nav?.kind !== 'selection-offset') throw new Error('expected a selection-offset nav');
    expect(nav.intent).toBe('jump');
    expect(nav.anchor.blockIndex).toBe(2);
  });

  test('activates from a keyboard Enter press', async () => {
    const user = userEvent.setup();
    const { editor } = makeEditor(DOC, 2);
    renderButton(editor);

    screen.getByTestId('view-in-source-bubble-button').focus();
    await user.keyboard('{Enter}');

    expect(flipped).toEqual(['doc-view']);
    expect(peekPendingSourceNavigation('doc-view')?.kind).toBe('selection-offset');
  });

  test('activates from a keyboard Space press', async () => {
    const user = userEvent.setup();
    const { editor } = makeEditor(DOC, 2);
    renderButton(editor);

    screen.getByTestId('view-in-source-bubble-button').focus();
    await user.keyboard('[Space]');

    expect(flipped).toEqual(['doc-view']);
    expect(peekPendingSourceNavigation('doc-view')?.kind).toBe('selection-offset');
  });

  test('the action is not bound to mousedown alone, so it never fires from mousedown', () => {
    const { editor } = makeEditor(DOC, 2);
    renderButton(editor);

    // A bare mousedown (no click, no keyboard) must not act — that is exactly the
    // mouse-down-only shape the icon siblings use, which the keyboard cannot reach.
    fireEvent.mouseDown(screen.getByTestId('view-in-source-bubble-button'));

    expect(flipped).toEqual([]);
    expect(peekPendingSourceNavigation('doc-view')).toBeNull();
  });

  test('no-ops when the editor has no registered doc name', async () => {
    const user = userEvent.setup();
    const { editor } = makeEditor(DOC, 2, null);
    renderButton(editor);

    await user.click(screen.getByTestId('view-in-source-bubble-button'));

    expect(flipped).toEqual([]);
  });
});
