/**
 * RenderedDiffView — the WYSIWYG (unified inline track-changes) Timeline diff.
 *
 * Renders the "after" version through a read-only static TipTap editor (the
 * `SkillMarkdownViewer` pattern — real `.ProseMirror` DOM, whole-document parse,
 * NO Y.Doc / provider / awareness), and overlays a static `DecorationSet`:
 * inserted words highlighted inline (`ok-diff-ins`), removed content struck
 * through in place (`ok-diff-del`) as widget decorations that re-render the
 * before-doc slice through the real schema.
 *
 * The diff itself is computed by the pure engine (`buildRenderedDiff`); this
 * component is the render half. `useRenderedDiff` is exported so the pane can
 * decide rendered-vs-Source before mounting an editor (a `false` engine result
 * → the pane falls back to the raw Source diff).
 *
 * STOP: do not add Collaboration / CollaborationCursor here — this is a static
 * editor and those require a Y.Doc (same contract `SkillMarkdownViewer` documents).
 */
import { Extension, getSchema } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';
import {
  buildRenderedDiff,
  type RenderedDiff,
  type RenderedDiffResult,
} from '@/lib/rendered-diff/build-rendered-diff';
import { buildDiffDecorations } from '@/lib/rendered-diff/diff-decorations';
import { diffExtensions } from '@/lib/rendered-diff/diff-extensions';

// Stable schema for the diff editor — `diffExtensions` is module-const, so the
// schema is built once. The engine materializes docs against it; decorations
// are position-based, so they apply to the editor's (structurally identical)
// doc regardless of schema-instance identity.
const diffSchema = getSchema(diffExtensions);

/**
 * Compute the rendered diff between two markdown bodies. Plain function (NOT a
 * React hook, despite being called in render) — named `compute*` so hook-lint
 * doesn't treat it as one; safe to call conditionally. The pane branches on `ok`.
 */
export function computeRenderedDiff(before: string, after: string): RenderedDiffResult {
  return buildRenderedDiff(before, after, diffSchema, getSharedMarkdownManager());
}

const DiffDecorations = Extension.create<{ decorations: DecorationSet }>({
  name: 'renderedDiffDecorations',
  addOptions() {
    return { decorations: DecorationSet.empty };
  },
  addProseMirrorPlugins() {
    const decorations = this.options.decorations;
    return [
      new Plugin({
        key: new PluginKey('renderedDiffDecorations'),
        props: { decorations: () => decorations },
      }),
    ];
  },
});

export function RenderedDiffView({ diff }: { diff: RenderedDiff }) {
  const decorations = buildDiffDecorations(
    diff.afterDoc,
    diff.beforeDoc,
    diff.changes,
    diff.markChanges,
    diffSchema,
  );

  const editor = useEditor(
    {
      editable: false,
      extensions: [...diffExtensions, DiffDecorations.configure({ decorations })],
      content: diff.afterDoc.toJSON(),
      editorProps: {
        // Same content-surface padding as the real editor so spacing matches.
        attributes: { class: 'pt-4 pb-4' },
      },
    },
    [diff],
  );

  // Portal the EditorContent into a privately-owned target so TipTap's
  // DOM-vacuum can't pull in sibling nodes (the `no-unportaled-editor-content`
  // GritQL rule + H6 contract, precedent #44). Mirrors `SkillMarkdownViewer`.
  const [portalTarget] = useState(() => {
    const el = document.createElement('div');
    el.style.display = 'contents';
    return el;
  });
  const portalSlotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = portalSlotRef.current;
    if (!slot) return;
    slot.appendChild(portalTarget);
    return () => {
      if (portalTarget.parentNode === slot) slot.removeChild(portalTarget);
    };
  }, [portalTarget]);

  return (
    <div className="editor-doc-scroll min-h-0 flex-1" data-testid="rendered-diff-view">
      <div className="tiptap-editor">
        <div ref={portalSlotRef} style={{ display: 'contents' }} />
      </div>
      {createPortal(
        // biome-ignore lint/plugin/no-unportaled-editor-content: portaled site — view.dom parent is the exclusively-owned portalTarget per the H6 contract (PRECEDENTS.md #44)
        <EditorContent editor={editor} className="tiptap-editor-portal-content" />,
        portalTarget,
      )}
    </div>
  );
}
