import { Extension, getSchema } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setEditorDocName } from '@/editor/extensions/doc-context';
import { scopeExtensionsToDocument } from '@/editor/extensions/shared';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';
import {
  buildRenderedDiff,
  type RenderedDiff,
  type RenderedDiffResult,
} from '@/lib/rendered-diff/build-rendered-diff';
import { buildDiffDecorations } from '@/lib/rendered-diff/diff-decorations';
import { diffExtensions } from '@/lib/rendered-diff/diff-extensions';
import { renderDeletedJsxBlock } from '@/lib/rendered-diff/diff-jsx-block';

const diffSchema = getSchema(diffExtensions);

export function computeRenderedDiff(before: string, after: string): RenderedDiffResult {
  return buildRenderedDiff(before, after, diffSchema, getSharedMarkdownManager());
}

const DiffDecorations = Extension.create<{ diff: RenderedDiff | null }>({
  name: 'renderedDiffDecorations',
  addOptions() {
    return { diff: null };
  },
  addProseMirrorPlugins() {
    const { diff } = this.options;
    const editor = this.editor;
    const decorations = diff
      ? buildDiffDecorations(
          diff.afterDoc,
          diff.beforeDoc,
          diff.changes,
          diff.markChanges,
          diffSchema,
          (node) => renderDeletedJsxBlock(editor, node),
        )
      : DecorationSet.empty;
    return [
      new Plugin({
        key: new PluginKey('renderedDiffDecorations'),
        props: { decorations: () => decorations },
      }),
    ];
  },
});

export function RenderedDiffView({ diff, docName }: { diff: RenderedDiff; docName: string }) {
  const editor = useEditor(
    {
      editable: false,
      extensions: [
        ...scopeExtensionsToDocument(diffExtensions, docName),
        DiffDecorations.configure({ diff }),
      ],
      content: diff.afterDoc.toJSON(),
      onBeforeCreate: ({ editor }) => setEditorDocName(editor, docName),
      editorProps: {
        attributes: { class: 'pt-4' },
      },
    },
    [diff, docName],
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
    <div
      className="ok-rendered-diff editor-doc-scroll min-h-0 flex-1"
      data-testid="rendered-diff-view"
    >
      <div className="tiptap-editor">
        <div ref={portalSlotRef} style={{ display: 'contents' }} />
      </div>
      {createPortal(
        // oxlint-disable-next-line ok/no-unportaled-editor-content -- portaled site — view.dom parent is the exclusively-owned portalTarget per the H6 contract (PRECEDENTS.md #44)
        <EditorContent editor={editor} className="tiptap-editor-portal-content" />,
        portalTarget,
      )}
    </div>
  );
}
