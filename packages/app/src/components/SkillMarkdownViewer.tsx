import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReadonlyPropertyPanel } from '@/components/ReadonlyPropertyPanel';
import type { InternalLink } from '@/editor/extensions/internal-link';
import { sharedExtensions } from '@/editor/extensions/shared.ts';
import { SkillPathLinks } from '@/editor/extensions/skill-path-links';
import { getSharedMarkdownManager } from '@/editor/utils/md-singleton';

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
  flow?: boolean;
  linkBaseDocName?: string;
  skillPathLinkDocName?: string;
  onBundlePathClick?: (path: string) => boolean;
}) {
  const body = stripFrontmatter(text).body;
  const baseExtensions = linkBaseDocName
    ? sharedExtensions.map((ext) =>
        ext.name === 'link'
          ? (ext as typeof InternalLink).configure({ docName: linkBaseDocName })
          : ext,
      )
    : sharedExtensions;
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
      content: getSharedMarkdownManager().parseWithFallback(body),
      editorProps: {
        attributes: {
          class: 'pt-4',
        },
      },
    },
    [text, linkBaseDocName, skillPathLinkDocName],
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
          data-skill-markdown-viewer-state="loaded"
        >
          <div className="editor-doc-scroll min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask">
            {}
            <ReadonlyPropertyPanel text={text} />
            {grid}
          </div>
        </main>
      )}
      {createPortal(
        // biome-ignore lint/plugin/no-unportaled-editor-content: portaled site — view.dom parent is the exclusively-owned portalTarget per the H6 contract (PRECEDENTS.md #44)
        <EditorContent
          editor={editor}
          className={flow ? 'tiptap-editor-portal-content' : 'tiptap-editor-portal-content h-full'}
        />,
        portalTarget,
      )}
    </>
  );
}
