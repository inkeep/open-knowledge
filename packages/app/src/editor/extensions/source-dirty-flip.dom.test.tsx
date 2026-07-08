/**
 * Interior-content flip pin — the real-engine (mounted-editor) rung.
 *
 * The source-dirty observer's `contentChanged` branch is the sole guardian of
 * registered PM-editable interiors: when a user edits INSIDE a pristine
 * jsxComponent (Callout/Accordion/Tabs), the flip is what re-routes serialize
 * off the verbatim-sourceRaw fast path onto the fresh re-derive path. If that
 * branch ever stops firing, the editor keeps showing the edit while every
 * fresh parser (teammate, reopen, disk) sees the stale pre-edit bytes.
 *
 * The origin-guard suite drives the plugin against a hand-rolled EditorState;
 * this drives a mounted `new Editor` so the flip is exercised through the same
 * dispatch → appendTransaction path production uses. The edit is content-only
 * (no prop change) so the pin isolates the `contentChanged` term specifically:
 * reverting only that term turns this test red.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sharedExtensions as coreExtensions, MarkdownManager } from '@inkeep/open-knowledge-core';
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
// The app extensions carry the SourceDirtyObserver plugin + jsxComponent
// NodeView; the mounted editor must use these, not core's (which omit the
// observer). Serialization still goes through core's MarkdownManager — the
// same server-side path that turns app-editor JSON into persisted bytes.
import { sharedExtensions } from './shared';

const mdManager = new MarkdownManager({ extensions: coreExtensions });

const CALLOUT_SOURCE_RAW = '<Callout title="A">\n\nA body\n\n</Callout>';

/** A doc with one pristine (sourceDirty:false) Callout carrying authoritative
 *  sourceRaw + a paragraph child — the shape mdast→PM parse handlers emit. */
function pristineCalloutDoc(): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'jsxComponent',
        attrs: {
          content: '',
          componentName: 'Callout',
          kind: 'element',
          attributes: [],
          sourceRaw: CALLOUT_SOURCE_RAW,
          sourceDirty: false,
          props: { title: 'A' },
        },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A body' }] }],
      },
    ],
  };
}

function mountEditor(content: JSONContent): { editor: Editor; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    content,
    extensions: sharedExtensions,
    editable: true,
  });
  return { editor, container };
}

/** First jsxComponent position + a text position inside its interior. */
function locateCalloutInterior(editor: Editor): { calloutPos: number; interiorTextPos: number } {
  let calloutPos = -1;
  let interiorTextPos = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'jsxComponent' && calloutPos === -1) {
      calloutPos = pos;
      return true; // descend into the component
    }
    if (calloutPos !== -1 && node.isText && interiorTextPos === -1) {
      interiorTextPos = pos + 1; // inside the text run
      return false;
    }
    return true;
  });
  if (calloutPos === -1 || interiorTextPos === -1) {
    throw new Error('Callout interior text not found');
  }
  return { calloutPos, interiorTextPos };
}

function calloutSourceDirty(editor: Editor): boolean {
  let dirty = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') {
      dirty = Boolean(node.attrs.sourceDirty);
      return false;
    }
    return true;
  });
  return dirty;
}

describe('interior-content edit flips sourceDirty and re-derives serialization', () => {
  afterEach(() => {
    cleanup();
  });

  test('an in-place interior edit flips sourceDirty and the serializer re-derives fresh bytes', () => {
    const { editor, container } = mountEditor(pristineCalloutDoc());
    try {
      // The Callout mounts pristine — a fresh-insert with authoritative
      // sourceRaw must not be pre-marked dirty, or the pin proves nothing.
      expect(calloutSourceDirty(editor)).toBe(false);

      const { interiorTextPos } = locateCalloutInterior(editor);
      editor.commands.insertContentAt(interiorTextPos, 'ZZZ');

      // Same dispatch: reading editor.state after the single command reflects
      // both the content mutation and the appended sourceDirty flip.
      expect(calloutSourceDirty(editor)).toBe(true);

      // The serializer must re-derive from the fragment: the edited token
      // reaches the bytes, and the output is no longer the verbatim sourceRaw.
      const serialized = mdManager.serialize(editor.getJSON());
      expect(serialized).toContain('ZZZ');
      expect(serialized).not.toBe(CALLOUT_SOURCE_RAW);
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('serialize stays on the verbatim-sourceRaw fast path when the interior is untouched', () => {
    // The complement of the flip pin: an unedited pristine Callout must emit
    // its sourceRaw verbatim (no ZZZ, no re-derive). Together the two tests
    // show the flip is what moves serialize between the two paths.
    const { editor, container } = mountEditor(pristineCalloutDoc());
    try {
      expect(calloutSourceDirty(editor)).toBe(false);
      const serialized = mdManager.serialize(editor.getJSON());
      expect(serialized.trim()).toBe(CALLOUT_SOURCE_RAW.trim());
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
