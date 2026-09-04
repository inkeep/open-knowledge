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

const diffSchema = getSchema(diffExtensions);

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
        attributes: { class: 'pt-4' },
      },
    },
    [diff],
  );

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
