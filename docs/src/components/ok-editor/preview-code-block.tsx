'use client';

import { CodeBlockFidelity, PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import {
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react';
import { Trash2 } from 'lucide-react';

const THEME_VARS = PREVIEW_THEME_TOKENS.map((t) => `${t.name}:${t.light}`).join(';');

const CHART_PALETTE = [
  '--chart-1:#93c5fd',
  '--chart-2:#60a5fa',
  '--chart-3:#3784ff',
  '--chart-4:#2563eb',
  '--chart-5:#1d4ed8',
].join(';');

function buildSrcDoc(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${THEME_VARS};${CHART_PALETTE}}
html,body{margin:0;height:100%;background:transparent;color:var(--foreground);font-family:system-ui,-apple-system,sans-serif}
/* Embeds are static, sized-to-fit content — never show the iframe's OS
   scrollbar (a sub-pixel overflow shouldn't paint a thick gutter). */
html{scrollbar-width:none}
html::-webkit-scrollbar{width:0;height:0;display:none}
*{box-sizing:border-box}
</style></head><body>${html}</body></html>`;
}

const DEFAULT_PREVIEW_HEIGHT = 230;

function previewHeight(meta: string): number {
  const m = /\bh=(\d+)\b/.exec(meta);
  return m ? Number(m[1]) : DEFAULT_PREVIEW_HEIGHT;
}

function PreviewCodeBlockView({ node, deleteNode }: NodeViewProps) {
  const language = typeof node.attrs.language === 'string' ? node.attrs.language : '';
  const meta = typeof node.attrs.meta === 'string' ? node.attrs.meta : '';
  const isPreview = language === 'html' && /\bpreview\b/.test(meta);

  if (isPreview) {
    return (
      <NodeViewWrapper className="ok-embed-preview" contentEditable={false}>
        <iframe
          sandbox="allow-scripts"
          srcDoc={buildSrcDoc(node.textContent)}
          title="Embedded preview"
          className="ok-embed-iframe"
          style={{ height: `${previewHeight(meta)}px` }}
        />
        {/* The embed isn't editable, but it can be removed. Hover-revealed
            delete button (top-right); mousedown-preventDefault keeps the editor
            from grabbing a selection before the click deletes the node. */}
        <button
          type="button"
          className="ok-embed-delete"
          aria-label="Delete embed"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => deleteNode()}
        >
          <Trash2 className="size-3.5" />
        </button>
        {/* The code text stays in the document (round-trips to markdown) but is
            hidden while the preview renders. */}
        <pre hidden>
          <NodeViewContent />
        </pre>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper>
      <pre className="ok-code-block">
        <NodeViewContent />
      </pre>
    </NodeViewWrapper>
  );
}

export const PreviewCodeBlock = CodeBlockFidelity.extend({
  addNodeView() {
    return ReactNodeViewRenderer(PreviewCodeBlockView);
  },
});
