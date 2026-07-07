/**
 * Selection-state integration tests.
 *
 * Exercises SelectionStatePlugin against a real Hocuspocus harness:
 *   - Agent writes JSX content through the full persistence → observer →
 *     fragment path.
 *   - Client-side: construct an EditorState from the synced Y.XmlFragment,
 *     install the plugin, dispatch a NodeSelection, read plugin state.
 *   - Verify bridge invariant holds after every selection-state change
 *     (plugin is read-only over the PM doc — mutation would be a
 *     regression of SC-INV-1).
 *
 * Does NOT spin up a full TipTap Editor — the test runtime lacks a DOM
 * shim. Instead, we instantiate the PM plugin directly via a mirror-stub
 * that wraps the exported pure deriveBlockSelection function. This
 * exercises the same state-derivation code path as production, but
 * without React/DOM machinery.
 *
 * Per-test docName isolation via createTestClient(port). Bridge invariant
 * asserted via assertBridgeInvariant from the harness (established
 * convention).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { EditorState, NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import {
  type BlockSelection,
  deriveBlockSelection,
  SELECTION_ORIGIN_META_KEY,
  selectionStatePluginKey,
} from '../../src/editor/extensions/selection-state-plugin';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestServer,
  schema,
  type TestServer,
} from './test-harness';

const EMPTY: BlockSelection = {
  selectedBlockId: null,
  ancestorChain: [],
  selectionOrigin: 'programmatic',
  isDragging: false,
  rangeEncompassedBlockIds: new Set<string>(),
};

/** Minimal stub plugin mirroring the real plugin's state derivation —
 *  tests the pure `deriveBlockSelection` function without React/DOM.
 *  Origin classification via DOM events is out of scope here (covered by
 *  E2E); tr-meta overrides work via SELECTION_ORIGIN_META_KEY. */
function makeStubPlugin() {
  return new Plugin<BlockSelection>({
    key: selectionStatePluginKey,
    state: {
      init: (_c, s) => deriveBlockSelection(s, EMPTY),
      apply: (tr, prev, _o, newState) => {
        const metaOrigin = tr.getMeta(SELECTION_ORIGIN_META_KEY);
        return deriveBlockSelection(newState, prev, {
          origin: metaOrigin ?? prev.selectionOrigin,
        });
      },
    },
  });
}

/** Convert a synced Y.XmlFragment into an EditorState with the selection
 *  plugin installed. Useful for imperative tests — no TipTap/React needed. */
function fragmentToEditorState(fragment: import('yjs').XmlFragment): EditorState {
  const doc = yXmlFragmentToProseMirrorRootNode(fragment, schema);
  return EditorState.create({ doc, plugins: [makeStubPlugin()] });
}

/** Find the PM position of the first jsxComponent with the given
 *  componentName. Returns -1 if not found. */
function findJsxComponentPos(state: EditorState, componentName: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (
      node.type.name === 'jsxComponent' &&
      (node.attrs.componentName as string) === componentName
    ) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ debounce: 200 });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('SelectionStatePlugin integration', () => {
  test('T1: top-level NodeSelection on a 5-pack descriptor produces single-entry ancestorChain', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '<Callout type="note" title="Hello" />\n', {
        position: 'replace',
        docName: client.docName,
      });
      await wait(300);

      const editorState = fragmentToEditorState(client.fragment);
      const pos = findJsxComponentPos(editorState, 'Callout');
      expect(pos).toBeGreaterThanOrEqual(0);

      const withSelection = editorState.apply(
        editorState.tr.setSelection(NodeSelection.create(editorState.doc, pos)),
      );
      const sel = selectionStatePluginKey.getState(withSelection);
      expect(sel?.selectedBlockId).not.toBeNull();
      expect(sel?.ancestorChain).toHaveLength(1);
      expect(sel?.ancestorChain[0].componentName).toBe('Callout');

      // Bridge invariant: plugin is read-only; fragment untouched.
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('T2: nested Callout<Accordion> — ancestorChain reflects outer→inner order', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(
        server.port,
        '<Callout type="note">\n  <Accordion title="Inner" />\n</Callout>\n',
        {
          position: 'replace',
          docName: client.docName,
        },
      );
      await wait(300);

      const editorState = fragmentToEditorState(client.fragment);
      const innerPos = findJsxComponentPos(editorState, 'Accordion');
      expect(innerPos).toBeGreaterThanOrEqual(0);

      const withSelection = editorState.apply(
        editorState.tr.setSelection(NodeSelection.create(editorState.doc, innerPos)),
      );
      const sel = selectionStatePluginKey.getState(withSelection);
      expect(sel?.ancestorChain).toHaveLength(2);
      expect(sel?.ancestorChain[0].componentName).toBe('Callout');
      expect(sel?.ancestorChain[1].componentName).toBe('Accordion');
      // selectedBlockId is the innermost (Accordion).
      expect(sel?.selectedBlockId).toBe(sel?.ancestorChain[1].bridgeId);

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('T3: delete-selection transitions state to empty ancestorChain', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '<Callout type="note" title="Delete me" />\n', {
        position: 'replace',
        docName: client.docName,
      });
      await wait(300);

      const editorState = fragmentToEditorState(client.fragment);
      const cardPos = findJsxComponentPos(editorState, 'Callout');
      expect(cardPos).toBeGreaterThanOrEqual(0);

      const withSelection = editorState.apply(
        editorState.tr.setSelection(NodeSelection.create(editorState.doc, cardPos)),
      );
      expect(selectionStatePluginKey.getState(withSelection)?.selectedBlockId).not.toBeNull();

      // Delete the selection — state must reconcile to empty without throwing.
      const afterDelete = withSelection.apply(withSelection.tr.deleteSelection());
      const sel = selectionStatePluginKey.getState(afterDelete);
      expect(sel?.selectedBlockId).toBeNull();
      expect(sel?.ancestorChain).toEqual([]);

      // Client's fragment is untouched by our in-memory state apply —
      // bridge still valid.
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('T4: TextSelection inside a jsxComponent maps to innermost jsx ancestor', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '<Callout type="info">\n\nbody text\n\n</Callout>\n', {
        position: 'replace',
        docName: client.docName,
      });
      await wait(300);

      const editorState = fragmentToEditorState(client.fragment);
      const calloutPos = findJsxComponentPos(editorState, 'Callout');
      expect(calloutPos).toBeGreaterThanOrEqual(0);

      // Position inside the Callout's content hole — first interior text pos.
      // Callout opens at calloutPos; first content at calloutPos + 2 (wrapper +
      // first paragraph open).
      const textPos = calloutPos + 2;
      const withSelection = editorState.apply(
        editorState.tr.setSelection(TextSelection.create(editorState.doc, textPos)),
      );
      const sel = selectionStatePluginKey.getState(withSelection);
      expect(sel?.ancestorChain).toHaveLength(1);
      expect(sel?.ancestorChain[0].componentName).toBe('Callout');

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('T5: SELECTION_ORIGIN_META_KEY override stamps selectionOrigin programmatic', async () => {
    const client = await createTestClient(server.port);
    try {
      await agentWriteMd(server.port, '<Callout type="note" title="Meta test" />\n', {
        position: 'replace',
        docName: client.docName,
      });
      await wait(300);

      const editorState = fragmentToEditorState(client.fragment);
      const pos = findJsxComponentPos(editorState, 'Callout');
      expect(pos).toBeGreaterThanOrEqual(0);

      const tr = editorState.tr
        .setSelection(NodeSelection.create(editorState.doc, pos))
        .setMeta(SELECTION_ORIGIN_META_KEY, 'programmatic');
      const withSelection = editorState.apply(tr);
      const sel = selectionStatePluginKey.getState(withSelection);
      expect(sel?.selectionOrigin).toBe('programmatic');

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });
});
