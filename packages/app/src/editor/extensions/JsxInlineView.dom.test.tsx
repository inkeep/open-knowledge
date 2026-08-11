/**
 * Pins the registered-inline-widget contract:
 *
 *   1. A `jsxInline` node with `componentName` renders the descriptor's
 *      component (not source text); the thin shape still renders source.
 *   2. NodeSelection on the widget opens the PropPanel popover.
 *   3. A PropPanel commit rewrites `props` and stamps `sourceDirty` so the
 *      serializer reconstructs from the edit.
 *
 * Tier: `.dom.test.tsx` (jsdom) — drives a mounted TipTap Editor.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

// React NodeViews only mount under the @tiptap/react host (`EditorContent`),
// so the harness renders a real host instead of a bare `new Editor()`.
// Portalled per the H6 cross-doc DOM bleed contract (no-unportaled-editor-content).
function Host({ content, onEditor }: { content: object; onEditor: (e: Editor) => void }) {
  const editor = useEditor({
    extensions: sharedExtensions.map((extension) =>
      extension.name === 'jsxInline'
        ? extension.configure({ docName: 'all-link-types' })
        : extension,
    ),
    editable: true,
    content,
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));
  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);
  if (editor) onEditor(editor);
  return createPortal(
    // biome-ignore lint/plugin/no-unportaled-editor-content: portalled per the H6 contract — this IS the sanctioned createPortal shape, in a test harness with a per-render exclusive target
    <EditorContent editor={editor} />,
    portalTarget,
  );
}

function mountEditor(content: object): {
  getEditor: () => Editor;
  view: ReturnType<typeof render>;
} {
  let captured: Editor | null = null;
  const view = render(
    <Host
      content={content}
      onEditor={(e) => {
        captured = e;
      }}
    />,
  );
  return {
    getEditor: () => {
      if (!captured) throw new Error('editor not mounted');
      return captured;
    },
    view,
  };
}

function docWithInline(attrs: Record<string, unknown>, text?: string) {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before ' },
          {
            type: 'jsxInline',
            attrs,
            ...(text ? { content: [{ type: 'text', text }] } : {}),
          },
          { type: 'text', text: ' after' },
        ],
      },
    ],
  };
}

afterEach(cleanup);

describe('JsxInlineView', () => {
  test('normalizes a local inline img src against its document before rendering', async () => {
    const desktopWindow = window as typeof window & {
      okDesktop?: { config: { apiOrigin: string } };
    };
    desktopWindow.okDesktop = { config: { apiOrigin: 'http://localhost:53351' } };

    try {
      mountEditor(
        docWithInline({
          componentName: 'img',
          sourceRaw: '<img src="assets/space image.png" alt="Working self-closing HTML image" />',
          props: {
            src: 'assets/space image.png',
            alt: 'Working self-closing HTML image',
          },
        }),
      );

      await waitFor(() => {
        expect(
          document
            .querySelector<HTMLImageElement>('img[alt="Working self-closing HTML image"]')
            ?.getAttribute('src'),
        ).toBe('http://localhost:53351/assets/space image.png');
      });
    } finally {
      delete desktopWindow.okDesktop;
    }
  });

  test('a registered componentName renders the descriptor widget', async () => {
    mountEditor(
      docWithInline({
        componentName: 'Callout',
        sourceRaw: '<Callout type="warning" title="careful" />',
        props: { type: 'warning', title: 'careful' },
      }),
    );
    await waitFor(() => {
      // The React NodeView's widget span, not renderHTML's fallback DOM.
      expect(document.querySelector('[data-jsx-inline-widget]')).toBeTruthy();
    });
    // The rendered widget shows the Callout chrome, not the raw source.
    expect(document.body.textContent).not.toContain('<Callout');
  });

  test('the thin shape still renders raw source text', async () => {
    mountEditor(docWithInline({ componentName: '' }, '<Unregistered />'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('<Unregistered />');
    });
  });

  test('NodeSelection opens the PropPanel popover and a commit stamps sourceDirty', async () => {
    const { getEditor } = mountEditor(
      docWithInline({
        componentName: 'Callout',
        sourceRaw: '<Callout type="warning" title="careful" />',
        props: { type: 'warning', title: 'careful' },
      }),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-jsx-inline-widget]')).toBeTruthy();
    });
    const editor = getEditor();
    {
      // The widget sits after 'before ' (pos 1 + 7 text chars).
      editor.commands.setNodeSelection(1 + 'before '.length);

      const titleInput = await screen.findByDisplayValue('careful');
      fireEvent.change(titleInput, { target: { value: 'updated' } });

      await waitFor(() => {
        let dirty = false;
        let title = '';
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'jsxInline') {
            dirty = node.attrs.sourceDirty === true;
            title = (node.attrs.props as Record<string, string>).title;
          }
        });
        expect(dirty).toBe(true);
        expect(title).toBe('updated');
      });
    }
  });
});
