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
import { ReadonlyPropertyPanel } from '@/components/ReadonlyPropertyPanel';
import type { InternalLink } from '@/editor/extensions/internal-link';
import { sharedExtensions } from '@/editor/extensions/shared.ts';
import { SkillPathLinks } from '@/editor/extensions/skill-path-links';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';

/**
 * Rendered view for a skill bundle markdown file. `text` is the raw file
 * content (frontmatter included). The parent `key`-remounts per file and the
 * `[text]` dep rebuilds the editor on content change; `useEditor` destroys the
 * prior instance on teardown, so there is no manual lifecycle bookkeeping.
 */
export function SkillMarkdownViewer({
  fileName,
  text,
  flow = false,
  linkBaseDocName,
  skillPathLinkDocName,
  onBundlePathClick,
}: {
  fileName: string;
  text: string;
  /**
   * Flow mode: render as an auto-height block inside a caller-owned scroll (so
   * the full-page skill preview can stack properties above and the file list
   * below the prose in ONE doc-width scroll), instead of a full-height,
   * self-scrolling `<main>` pane. Default is the standalone pane.
   */
  flow?: boolean;
  /**
   * The live doc name of THIS bundle file (`skillFileLiveDocName(scope, name,
   * rel)`), used only as the RELATIVE-link base so a `[…](references/x.md)` link
   * in a skill's SKILL.md / reference resolves to the sibling bundle doc instead
   * of a content-dir path that doesn't exist — otherwise valid skill references
   * render as broken links (§8.3). Omit for previews with no resolved skill
   * identity (an un-imported explore skill has no bundle docs to link to).
   */
  linkBaseDocName?: string;
  /**
   * The skill's SKILL doc name (`skillLiveDocName(scope, name)`). When set, the
   * `references/…` / `scripts/…` bundle-path code chips become clickable — the
   * same navigation the editable editor has — so a read-only skill (built-ins,
   * scripts) can jump to its sibling bundle files instead of dead chips (
   * part 2). `skillBundlePathNavHash` keeps built-ins + scripts read-only.
   */
  skillPathLinkDocName?: string;
  /**
   * Context override for a clicked bundle-path chip. The in-preview file list
   * passes this to SWITCH its selected file instead of navigating away to a
   * standalone skill-file view. Return `true` to mark the click handled.
   */
  onBundlePathClick?: (path: string) => boolean;
}) {
  // The markdown pipeline expects a frontmatter-free body (parse() contract);
  // the YAML region is metadata, not prose, so it is not rendered here.
  const body = stripFrontmatter(text).body;
  // Reconfigure only the internal-link extension (`name === 'link'`) with this
  // file's doc name so relative links resolve against the skill bundle dir; the
  // rest of `sharedExtensions` is reused unchanged.
  const baseExtensions = linkBaseDocName
    ? sharedExtensions.map((ext) =>
        ext.name === 'link'
          ? (ext as typeof InternalLink).configure({ docName: linkBaseDocName })
          : ext,
      )
    : sharedExtensions;
  // Add the bundle-path link affordance (clickable `references/…` chips) when the
  // skill identity is known. Read-only editor still fires ProseMirror handleClick.
  const extensions = skillPathLinkDocName
    ? [
        ...baseExtensions,
        SkillPathLinks.configure({ docName: skillPathLinkDocName, onBundlePathClick }),
      ]
    : baseExtensions;
  const editor = useEditor(
    {
      extensions,
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
          class: 'pt-4',
        },
      },
    },
    [text, linkBaseDocName, skillPathLinkDocName],
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

  // Mirror the editor's content-column grid so prose width + side rails match
  // the real editor layout. In flow mode this is the whole surface (the caller
  // owns the scroll); otherwise it lives inside a self-scrolling pane.
  const grid = (
    <div className="tiptap-editor">
      <div ref={portalSlotRef} style={{ display: 'contents' }} />
    </div>
  );
  return (
    <>
      {flow ? (
        <article
          className="bg-background"
          aria-label={fileName}
          data-skill-markdown-viewer=""
          data-skill-markdown-viewer-state="loaded"
        >
          {grid}
        </article>
      ) : (
        <main
          className="flex h-full min-h-0 flex-col bg-background"
          aria-label={fileName}
          data-skill-markdown-viewer=""
          // This component only renders the loaded state (loading/error live in
          // `useViewerText`); the sibling `-state` attr mirrors the `TextViewer`
          // convention so tests can assert the surface the same way.
          data-skill-markdown-viewer-state="loaded"
        >
          <div className="editor-doc-scroll min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask">
            {/* Read-only frontmatter Properties panel: the editable panel isn't
                reachable here (no CRDT provider), so metadata would be invisible. */}
            <ReadonlyPropertyPanel text={text} />
            {grid}
          </div>
        </main>
      )}
      {createPortal(
        // biome-ignore lint/plugin/no-unportaled-editor-content: portaled site — view.dom parent is the exclusively-owned portalTarget per the H6 contract (PRECEDENTS.md #44)
        <EditorContent
          editor={editor}
          // Fill the scroll pane in standalone mode; size to content in flow mode
          // so stacked properties/files above and below aren't crushed.
          className={flow ? 'tiptap-editor-portal-content' : 'tiptap-editor-portal-content h-full'}
        />,
        portalTarget,
      )}
    </>
  );
}
