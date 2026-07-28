/**
 * Generalized one-transaction pin for every non-slash `@tiptap/suggestion`
 * surface (precedent #58): tag (`#`), wiki-link (`[[`), and the Ask-AI
 * composer's `@`-mention. The slash menu has its own pin with an
 * interleaved-transaction consequence test in
 * `slash-command-atomicity.dom.test.tsx`.
 *
 * The invariant: selecting a suggestion item must land the trigger-range
 * delete and the content insert as ONE doc-changing transaction. If they land
 * as two, a transaction dispatched re-entrantly during the delete's own
 * dispatch (a plugin `appendTransaction`, a view update, or the y-prosemirror
 * binding reacting to the delete) can remap the selection onto an adjacent
 * `selectable: true` node, and the insert then REPLACES that node — silent
 * data loss.
 *
 * This is the runtime complement to the `no-split-suggestion-dispatch`
 * GritQL rule: the lint catches a bare trigger-delete dispatch statically;
 * this test drives each surface through a real Enter keydown (the production
 * `command` callbacks are closure-held inside the Suggestion plugins, so the
 * keydown path is the only way to run them) and asserts the
 * exactly-one-doc-changing-transaction oracle end to end — including any
 * second dispatch the lint cannot see.
 *
 * Corpus fetches (`/api/tags`, `/api/pages`) are stubbed at `global.fetch`;
 * every other endpoint returns a non-ok response, which each surface
 * tolerates by design (ranking context and asset lists degrade to empty).
 */

// `cleanup` satisfies the Tier-3 filename contract (every `*.dom.test.tsx`
// must value-import from `@testing-library/react`). The suite constructs the
// Editor directly rather than rendering through RTL; `cleanup` runs in
// `afterEach` so any future RTL render is torn down between tests.
import { cleanup } from '@testing-library/react';
import type { Extensions } from '@tiptap/core';
import { Editor } from '@tiptap/core';
import type { PluginKey } from '@tiptap/pm/state';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  composerMentionExtensions,
  composerMentionSuggestionKey,
} from '../composer-mention/composer-mention';
import { sharedExtensions } from './shared';
import { tagSuggestionKey } from './tag-suggestion';
import { wikiLinkSuggestionKey } from './wiki-link-suggestion';

/** Minimal `fetch` response shim — the corpus fetchers only touch `ok`,
 *  `status`, and `json()`. */
function fetchResponse(status: number, body: unknown): unknown {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Stub the corpus endpoints. One page ("alpha") and one tag ("alpha") are
 * enough for every surface to produce a selectable first item for the query
 * `alp`. Unknown endpoints 404 — the fetchers degrade to empty asset lists /
 * empty ranking context without rejecting the picker.
 */
function stubCorpusFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/tags')) {
        return fetchResponse(200, { tags: [{ name: 'alpha', count: 3, isLeaf: true }] });
      }
      if (url.includes('/api/pages')) {
        return fetchResponse(200, {
          pages: [
            {
              docName: 'alpha',
              title: 'Alpha',
              docExt: '.md',
              size: 1,
              modified: '2026-01-01T00:00:00.000Z',
            },
          ],
        });
      }
      return fetchResponse(404, {});
    }),
  );
}

function mountEditor(extensions: Extensions): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions,
    editable: true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
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
 * Deliver Enter to the surface's own Suggestion plugin `handleKeyDown` prop —
 * the same entry point ProseMirror's keydown dispatch uses — so the real
 * `render().onKeyDown` handler selects the highlighted item and invokes the
 * production `command` callback. Scoping to the one plugin (instead of
 * `view.someProp`) keeps a not-yet-populated menu from falling through to the
 * editor's base Enter binding, which would split the paragraph and end the
 * poll below with a false positive.
 */
function pressEnterOnSuggestion(editor: Editor, pluginKey: PluginKey): boolean {
  const plugin = pluginKey.get(editor.state);
  const handleKeyDown = plugin?.props.handleKeyDown;
  if (!plugin || !handleKeyDown) return false;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return handleKeyDown.call(plugin, editor.view, event) === true;
}

/**
 * The corpus loads through async `items()` (stubbed fetch + schema parse), so
 * the menu is not selectable on the first microtask: the suggestion handler
 * returns false while its item list is still empty, dispatching nothing. Poll
 * a real macrotask tick until Enter is handled.
 */
async function pressEnterOnceItemsLoad(editor: Editor, pluginKey: PluginKey): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (pressEnterOnSuggestion(editor, pluginKey)) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

interface SurfaceCase {
  name: string;
  extensions: () => Extensions;
  pluginKey: PluginKey;
  /** Typed at the head of the empty paragraph to open the menu. */
  trigger: string;
  /** Node type the selected item must have inserted. */
  insertedNodeType: string;
}

const SURFACES: SurfaceCase[] = [
  {
    name: 'tag suggestion (#)',
    extensions: () => sharedExtensions,
    pluginKey: tagSuggestionKey,
    trigger: '#alp',
    insertedNodeType: 'tag',
  },
  {
    name: 'wiki-link suggestion ([[)',
    extensions: () => sharedExtensions,
    pluginKey: wikiLinkSuggestionKey,
    trigger: '[[alp',
    insertedNodeType: 'wikiLink',
  },
  {
    name: 'composer mention (@)',
    extensions: () => composerMentionExtensions(),
    pluginKey: composerMentionSuggestionKey,
    trigger: '@alp',
    insertedNodeType: 'composerMention',
  },
];

function countNodesOfType(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
  });
  return count;
}

describe('Suggestion-surface insertion is a single transaction', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  for (const surface of SURFACES) {
    test(`${surface.name}: selecting an item dispatches exactly one doc-changing transaction`, async () => {
      stubCorpusFetch();
      const { editor, container } = mountEditor(surface.extensions());
      try {
        editor.commands.focus('end');
        editor.commands.insertContent(surface.trigger);

        let docChangingCount = 0;
        editor.on('transaction', ({ transaction }) => {
          if (transaction.docChanged) docChangingCount += 1;
        });

        // Precondition, not the assertion under test: if the menu never
        // became selectable the invariant below would pass vacuously.
        expect(await pressEnterOnceItemsLoad(editor, surface.pluginKey)).toBe(true);
        // Drain any deferred post-commit work (selection moves are
        // selection-only and must not add a doc-changing transaction).
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The insert landed in place of the trigger (guards against a
        // vacuous pass where Enter was handled but no item command ran).
        expect(countNodesOfType(editor, surface.insertedNodeType)).toBe(1);
        expect(editor.state.doc.textContent).not.toContain(surface.trigger);

        expect(docChangingCount).toBe(1);
      } finally {
        teardown(editor, container);
      }
    });
  }
});
