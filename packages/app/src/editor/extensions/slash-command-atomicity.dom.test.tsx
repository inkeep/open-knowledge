/**
 * Pin the atomicity invariant of the slash-command suggestion handler:
 *
 *   A suggestion command's trigger-range delete and its content insert must
 *   land as ONE transaction. If they land as two, any transaction dispatched
 *   in between can move the selection, and the insert then applies to
 *   whatever the selection became — replacing a pre-existing node instead of
 *   inserting a new one.
 *
 * The window is not hypothetical, and it is not an async gap between two
 * statements: `view.dispatch` runs `updateState` synchronously, and anything
 * it fires re-entrantly during the delete's own dispatch (a plugin
 * `appendTransaction`, a plugin-view or NodeView update, an
 * `editor.on('transaction')` listener, or the y-prosemirror binding reacting
 * to the just-applied delete) can dispatch its own transaction before
 * control reaches the insert. ProseMirror's selection remapping then settles
 * on the nearest selectable node, and a block `jsxComponent`
 * (`selectable: true`) adjacent to the trigger is exactly such a node. The
 * next `insertContent` targets a NodeSelection and REPLACES it, so the
 * document ends with the same node count it started with: the user typed
 * `/image`, pressed Enter, and their previous image vanished.
 *
 * The sibling suggestion extensions (`wiki-link-suggestion.ts`,
 * `tag-suggestion.ts`) already chain delete and insert into a single
 * transaction, which is why only the slash menu exhibits this.
 *
 * Two complementary assertions:
 *
 *   1. The direct oracle — exactly one doc-changing transaction per
 *      slash-command invocation. This is the invariant itself, independent
 *      of any particular interleaving.
 *   2. The consequence — with a selection-only transaction interleaved at
 *      the first doc-changing transaction, both the pre-existing component
 *      and the newly inserted one must survive. Under an atomic
 *      implementation the interleaved transaction cannot land mid-command,
 *      so the diverted selection is harmless.
 *
 * Tier: `.dom.test.tsx` (jsdom). TipTap's `new Editor({ ... })` needs
 * `document`/`window`, and the product `command` callback is reachable only
 * through `@tiptap/suggestion`'s renderer (`props.command` is closure-held),
 * so the test drives a real Enter keydown through the mounted plugin rather
 * than calling the callback directly.
 *
 * Contention-level coverage for the same invariant lives in
 * `tests/stress/slash-command-auto-open.e2e.ts`; this file is the
 * deterministic, contention-free tier.
 */

// `cleanup` satisfies the Tier-3 filename contract (every `*.dom.test.tsx`
// must value-import from `@testing-library/react`). The suite constructs the
// Editor directly rather than rendering through RTL; `cleanup` runs in
// `afterEach` so any future RTL render is torn down between tests.
import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

/** Byte-identifying attr of the component that must survive the slash insert. */
const PRIOR_SOURCE_RAW = '<img src="prior-marker.png" />';

/** Document position of the pre-existing `jsxComponent` (first top-level node). */
const PRIOR_POS = 0;

interface SuggestionPluginState {
  active: boolean;
}

/**
 * Locate the slash-command Suggestion plugin by plugin-key prefix.
 * `new PluginKey('slashCommand')` synthesizes a unique suffix, and
 * `slashCommandKey` is not exported from `slash-command.ts` — matching the
 * prefix avoids widening the production surface for a test.
 */
function getSlashState(editor: Editor): SuggestionPluginState | null {
  const plugin = editor.state.plugins.find((p) => {
    const keyName = (p as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    return typeof keyName === 'string' && keyName.startsWith('slashCommand');
  });
  return (plugin?.getState(editor.state) as SuggestionPluginState | undefined) ?? null;
}

function mountEditorWithPriorComponent(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: {
      type: 'doc',
      content: [
        {
          type: 'jsxComponent',
          attrs: {
            componentName: 'img',
            kind: 'element',
            attributes: [],
            sourceRaw: PRIOR_SOURCE_RAW,
            sourceDirty: false,
            props: { src: 'prior-marker.png' },
          },
        },
        { type: 'paragraph' },
      ],
    },
  });
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
  // Suggestion popups are appended to `document.body`, not to the editor
  // container; clear any that outlived destroy() so the next test starts clean.
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

/**
 * The Suggestion plugin's `view.update()` runs synchronously on dispatch and
 * may call `onStart`, which mounts a ReactRenderer. React 19 commits
 * concurrently — yield to the microtask queue twice so the popup is live
 * before the keydown is delivered.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Type `/image` in the trailing paragraph and assert the menu is open. */
async function openSlashMenu(editor: Editor): Promise<void> {
  editor.commands.focus('end');
  editor.commands.insertContent('/image');
  await flush();
  // Precondition, not the assertion under test: if the menu never opened the
  // failures below would be about a command that never ran.
  expect(getSlashState(editor)?.active).toBe(true);
}

/**
 * Deliver Enter the way ProseMirror does — `view.someProp('handleKeyDown')` —
 * so the real `render().onKeyDown` handler selects the highlighted item and
 * invokes the production `command` callback.
 */
function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event)) === true;
}

function jsxComponentSourceRaws(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') out.push(String(node.attrs.sourceRaw));
  });
  return out;
}

describe('Slash-command insertion is a single transaction', () => {
  afterEach(() => {
    cleanup();
  });

  test('running a slash-command item dispatches exactly one doc-changing transaction', async () => {
    const { editor, container } = mountEditorWithPriorComponent();
    try {
      await openSlashMenu(editor);

      let docChangingCount = 0;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) docChangingCount += 1;
      });

      expect(pressEnter(editor)).toBe(true);
      await flush();

      // The insert landed (guards against a vacuous zero-transaction pass).
      expect(jsxComponentSourceRaws(editor)).toHaveLength(2);

      expect(docChangingCount).toBe(1);
    } finally {
      teardown(editor, container);
    }
  });

  test('a transaction interleaved mid-command cannot divert the insert onto a prior node', async () => {
    const { editor, container } = mountEditorWithPriorComponent();
    try {
      await openSlashMenu(editor);

      // Model the CRDT-remap window: on the first doc-changing transaction of
      // the command, move the selection onto the pre-existing component. This
      // is selection-only — it changes no content, so any change in component
      // count is attributable solely to where the insert landed.
      let interleaved = false;
      editor.on('transaction', ({ transaction }) => {
        if (interleaved || !transaction.docChanged) return;
        interleaved = true;
        const { state, dispatch } = editor.view;
        dispatch(state.tr.setSelection(NodeSelection.create(state.doc, PRIOR_POS)));
      });

      expect(pressEnter(editor)).toBe(true);
      await flush();

      // Precondition: the interleaving actually happened.
      expect(interleaved).toBe(true);

      const sourceRaws = jsxComponentSourceRaws(editor);
      expect(sourceRaws).toHaveLength(2);
      expect(sourceRaws).toContain(PRIOR_SOURCE_RAW);
    } finally {
      teardown(editor, container);
    }
  });
});
