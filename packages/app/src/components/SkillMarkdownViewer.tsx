/**
 * Read-only RENDERED markdown view for a skill bundle `.md` / `.mdx` file.
 *
 * A skill bundle file lives outside the content dir (`~/.ok/skills/` for global
 * skills), so it is NOT a CRDT document and must never bind a Y.Doc, provider,
 * or awareness. This viewer renders the same prose a normal editor would —
 * markdown parsed through the editor's own pipeline, fed to a static read-only
 * TipTap editor — but the surface is non-editable and not collab-bound.
 *
 * STOP: do not add Collaboration / CollaborationCursor here. Those extensions
 * require a Y.Doc and throw in a static editor. We use the NON-collab app
 * `sharedExtensions` (collab is layered per-instance in `TiptapEditor`, never
 * in this set), so the schema matches the real editor without the Y.js binding.
 * The on-disk file is read-only by contract — there is no write path back.
 *
 * Loading / error / fetch lifecycle is NOT here — it lives in the shared
 * `useViewerText` hook (also backing `TextViewer`), wired by `SkillFileViewer`.
 * This component renders already-loaded text.
 */
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sharedExtensions } from '@/editor/extensions/shared.ts';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';

/**
 * Rendered view for a skill bundle markdown file. `text` is the raw file
 * content (frontmatter included). The parent `key`-remounts per file and the
 * `[text]` dep rebuilds the editor on content change; `useEditor` destroys the
 * prior instance on teardown, so there is no manual lifecycle bookkeeping.
 */
export function SkillMarkdownViewer({ fileName, text }: { fileName: string; text: string }) {
  // The markdown pipeline expects a frontmatter-free body (parse() contract);
  // the YAML region is metadata, not prose, so it is not rendered here.
  const body = stripFrontmatter(text).body;
  const editor = useEditor(
    {
      extensions: sharedExtensions,
      editable: false,
      // `parseWithFallback`, not `parse`: a bundle `.md`/`.mdx` is untrusted
      // on-disk content authored in any external editor. `parse()` throws on a
      // schema-hostile construct, which would crash this read-only viewer; the
      // fallback substitutes a raw node and always returns renderable content.
      content: getSharedMarkdownManager().parseWithFallback(body),
      editorProps: {
        attributes: {
          // Same content-surface padding as the real editor (TiptapEditor's
          // `editorProps.attributes.class`) so spacing matches.
          class: 'pt-4 pb-4',
        },
      },
    },
    [text],
  );

  // Portal the EditorContent into a private target so TipTap's
  // `PureEditorContent.componentDidMount` DOM-vacuum can't pull in sibling
  // nodes (the H6 cross-doc-bleed contract enforced by the
  // `no-unportaled-editor-content` GritQL rule). One stable target per mount.
  // Two `display: contents` layers (slot + target) make the EditorContent
  // refDiv act as a direct `.tiptap-editor` grid item via the
  // `.tiptap-editor-portal-content` descendant rule — same grid placement as
  // the real editor's portaled mount.
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
    <main
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={fileName}
      data-skill-markdown-viewer=""
      // This component only renders the loaded state (loading/error live in
      // `useViewerText`); the sibling `-state` attr mirrors the `TextViewer`
      // convention so tests can assert the surface the same way.
      data-skill-markdown-viewer-state="loaded"
    >
      <div className="editor-doc-scroll min-h-0 flex-1 overflow-auto">
        {/* Mirror the editor's content-column grid so prose width + side rails
            match the real editor layout. */}
        <div className="tiptap-editor">
          <div ref={portalSlotRef} style={{ display: 'contents' }} />
        </div>
      </div>
      {createPortal(
        // biome-ignore lint/plugin/no-unportaled-editor-content: portaled site — view.dom parent is the exclusively-owned portalTarget per the H6 contract (PRECEDENTS.md #44)
        <EditorContent editor={editor} className="tiptap-editor-portal-content h-full" />,
        portalTarget,
      )}
    </main>
  );
}
