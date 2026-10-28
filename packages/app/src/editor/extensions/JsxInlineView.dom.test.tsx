import { getParseHealth, resetParseHealth } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Editor, getSchema } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { EditorContent, useEditor } from '@tiptap/react';
import { updateYFragment } from '@tiptap/y-tiptap';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Toaster, toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfigContext, type ConfigContextValue } from '@/lib/config-context';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import {
  clearPendingSourceNavigationsForTest,
  peekPendingSourceNavigation,
} from '../source-editor-navigation.ts';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import { setEditorDocName } from './doc-context.ts';
import { sharedExtensions } from './shared';

vi.mock('@/lib/use-collab-url', () => ({
  useCollabUrl: () => ({ collabUrl: null }),
}));

const config: ConfigContextValue = {
  userBinding: null,
  userSynced: false,
  projectBinding: null,
  projectLocalBinding: null,
  okignoreBinding: null,
  okignoreSynced: false,
  userConfig: null,
  projectConfig: null,
  projectSynced: false,
  projectLocalConfig: null,
  projectLocalSynced: false,
  merged: null,
};

function Host({
  content,
  onEditor,
  ydoc,
}: {
  content: object;
  onEditor: (e: Editor) => void;
  ydoc?: Y.Doc;
}) {
  const editor = useEditor({
    extensions: [
      ...sharedExtensions.map((extension) =>
        extension.name === 'jsxInline'
          ? extension.configure({ docName: 'all-link-types' })
          : extension,
      ),
      ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
    ],
    editable: true,
    content: ydoc ? undefined : content,
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));
  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);
  if (editor) {
    if (ydoc) setEditorDocName(editor, 'budget-recovery');
    onEditor(editor);
  }
  return createPortal(
    // oxlint-disable-next-line ok/no-unportaled-editor-content -- portalled per the H6 contract — this IS the sanctioned createPortal shape, in a test harness with a per-render exclusive target
    <EditorContent editor={editor} />,
    portalTarget,
  );
}

const navigationDocs = new Set<Y.Doc>();

function mountEditor(
  content: object,
  source?: string,
): {
  getEditor: () => Editor;
  view: ReturnType<typeof render>;
} {
  let captured: Editor | null = null;
  const ydoc = source === undefined ? undefined : new Y.Doc();
  if (ydoc) {
    navigationDocs.add(ydoc);
    ydoc.getText('source').insert(0, source ?? '');
    updateYFragment(
      ydoc,
      ydoc.getXmlFragment('default'),
      getSchema(sharedExtensions).nodeFromJSON(content),
      {
        mapping: new Map(),
        isOMark: new Map(),
      },
    );
  }
  const view = render(
    <ConfigContext value={config}>
      <TooltipProvider>
        <Host
          content={content}
          ydoc={ydoc}
          onEditor={(e) => {
            captured = e;
          }}
        />
        <Toaster />
      </TooltipProvider>
    </ConfigContext>,
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

beforeEach(() => {
  resetParseHealth();
  clearPendingSourceNavigationsForTest();
});

afterEach(() => {
  cleanup();
  toast.dismiss();
  for (const doc of navigationDocs) doc.destroy();
  navigationDocs.clear();
});

function recoveryDocument(kind: 'block' | 'inline') {
  let items: unknown = 0;
  for (let i = 0; i < 65; i++) items = [items];
  const attrs = { componentName: 'Callout', props: { items }, sourceDirty: true };
  const middle =
    kind === 'block' ? { type: 'jsxComponent', attrs } : docWithInline(attrs).content[0];
  const content = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Prefix.' }] },
      middle,
      { type: 'paragraph', content: [{ type: 'text', text: 'Unrelated caret.' }] },
    ],
  };
  const jsx = `<Callout items={${JSON.stringify(items)}} />`;
  const source = `Prefix.\n\n${kind === 'block' ? jsx : `before ${jsx} after`}\n\nUnrelated caret.\n`;
  return { content, source };
}

describe('JsxInlineView', () => {
  test.each([
    ['block', 'click'],
    ['block', 'keyboard'],
    ['inline', 'click'],
    ['inline', 'keyboard'],
  ] as const)(
    'mounted over-budget %s recovery targets its node via %s',
    async (kind, activation) => {
      const user = userEvent.setup();
      const { content, source } = recoveryDocument(kind);
      const { getEditor } = mountEditor(content, source);
      const button = await screen.findByRole('button', { name: 'View in source markdown' });
      const editor = getEditor();
      act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1));
      expect(editor.state.selection.$from.index(0)).toBe(2);
      if (activation === 'click') await user.click(button);
      else {
        button.focus();
        await user.keyboard('{Enter}');
      }
      const nav = peekPendingSourceNavigation('budget-recovery');
      if (nav?.kind !== 'selection-offset') throw new Error('expected source navigation');
      expect(nav.anchor.blockIndex).toBe(1);
    },
  );

  test.each([
    ['block', 'changed'],
    ['block', 'removed'],
    ['inline', 'changed'],
    ['inline', 'removed'],
  ] as const)(
    'mounted over-budget %s recovery reports a %s target without jumping to the caret',
    async (kind, reason) => {
      const { content, source } = recoveryDocument(kind);
      const { getEditor } = mountEditor(content, source);
      const button = await screen.findByRole('button', { name: 'View in source markdown' });
      const editor = getEditor();
      let targetPos: number | undefined;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === (kind === 'block' ? 'jsxComponent' : 'jsxInline')) targetPos = pos;
      });
      if (targetPos === undefined) throw new Error('target missing');
      const pos = targetPos;
      const target = editor.state.doc.nodeAt(pos);
      if (!target) throw new Error('target missing');
      act(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
        const tr = editor.state.tr;
        if (reason === 'removed') tr.delete(pos, pos + target.nodeSize);
        else tr.setNodeMarkup(pos, undefined, { ...target.attrs, sourceRaw: 'changed' });
        editor.view.dispatch(tr);
        fireEvent.click(button);
      });
      expect(peekPendingSourceNavigation('budget-recovery')).toBeNull();
      expect(
        await screen.findByText(
          reason === 'removed'
            ? 'This component was removed.'
            : 'This component changed. Try again.',
        ),
      ).toBeTruthy();
      expect(getParseHealth().jsxActionAborted).toEqual({ 'edit-source': 1 });
    },
  );
  test('contains budget overflow introduced by a real legacy prop rename', async () => {
    const props = { id: 'x'.repeat(999998) };
    let mounted: ReturnType<typeof mountEditor> | undefined;
    expect(() => {
      mounted = mountEditor({
        type: 'doc',
        content: [
          {
            type: 'jsxComponent',
            attrs: {
              componentName: 'MirrorSource',
              props,
              sourceRaw: '',
              sourceDirty: true,
            },
          },
        ],
      });
    }).not.toThrow();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        'This component is too large to render.',
      );
    });
    expect(mounted?.getEditor().state.doc.firstChild?.attrs.props).toBe(props);
  });

  test('shows an over-budget block body once instead of repeating cached source', async () => {
    let items: unknown = 0;
    for (let i = 0; i < 65; i++) items = [items];
    mountEditor({
      type: 'doc',
      content: [
        {
          type: 'jsxComponent',
          attrs: {
            componentName: 'Callout',
            props: { items },
            sourceDirty: true,
            sourceRaw: '<Callout>\n\nRetain this body once.\n\n</Callout>',
          },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Retain this body once.' }] },
          ],
        },
      ],
    });
    await waitFor(() => {
      expect(document.querySelector('[data-jsx-props-error]')).toBeTruthy();
    });
    expect(
      document.querySelector('.ProseMirror')?.textContent?.match(/Retain this body once\./g),
    ).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain(
      'This component is too large to render.',
    );
    expect(screen.getByRole('button', { name: 'View in source markdown' })).toBeTruthy();
  });

  test.each(['block', 'inline'] as const)(
    'retains over-budget %s props as recoverable source without changing the document',
    async (kind) => {
      const manager = getSharedMarkdownManager();
      const source = `<Callout items={${'['.repeat(6000)}0${']'.repeat(6000)}} />`;
      const parsed = manager.parseWithFallback(
        kind === 'block' ? source : `before ${source} after`,
      );
      const { getEditor } = mountEditor(parsed);
      await waitFor(() => {
        expect(document.querySelector('.ProseMirror')?.textContent).toContain(source);
      });
      const editor = getEditor();
      const stored =
        kind === 'block' ? editor.state.doc.firstChild : editor.state.doc.firstChild?.child(1);
      expect(stored?.type.name).toBe(kind === 'block' ? 'rawMdxFallback' : 'jsxInline');
      expect(stored?.textContent).toBe(source);
      expect(manager.serialize(editor.getJSON())).toContain(source);
      if (kind === 'inline') expect(document.body.textContent).toContain(' after');
    },
  );

  test.each([
    ['block', 'cached'],
    ['block', 'empty'],
    ['inline', 'cached'],
    ['inline', 'empty'],
  ] as const)(
    'contains already-materialized over-budget %s props with %s source without mutating them',
    async (kind, cached) => {
      const source = cached === 'cached' ? '<Callout title="Recover in source mode" />' : '';
      let items: unknown = 0;
      for (let i = 0; i < 65; i++) items = [items];
      const attrs = {
        componentName: 'Callout',
        props: { items },
        sourceRaw: source,
        sourceDirty: true,
      };
      const content =
        kind === 'inline'
          ? docWithInline(attrs)
          : {
              type: 'doc',
              content: [{ type: 'jsxComponent', attrs }],
            };
      const { getEditor } = mountEditor(content);
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toContain(
          'This component is too large to render.',
        );
      });
      if (source)
        expect(document.querySelector('[data-jsx-props-error]')?.textContent).not.toContain(source);
      expect(screen.getByRole('button', { name: 'View in source markdown' })).toBeTruthy();
      const notice = screen.getByRole('status');
      const action = screen.getByRole('button', { name: 'View in source markdown' });
      expect(notice.querySelector('button')).toBeNull();
      expect(action.closest('[role="status"]')).toBeNull();
      expect(notice.closest(`[${OPT_OUT_ATTR}="true"]`)).not.toBeNull();
      const editor = getEditor();
      const stored =
        kind === 'block' ? editor.state.doc.firstChild : editor.state.doc.firstChild?.child(1);
      expect(stored?.attrs.props).toBe(attrs.props);
      expect(stored?.attrs.sourceDirty).toBe(true);
    },
  );

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
      expect(document.querySelector('[data-jsx-inline-widget]')).toBeTruthy();
    });
    expect(document.body.textContent).not.toContain('<Callout');
  });

  test('the thin shape still renders raw source text', async () => {
    mountEditor(docWithInline({ componentName: '' }, '<Unregistered />'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('<Unregistered />');
    });
  });

  test('an inline Mirror written with the older anchor spelling resolves, and an edit writes name', async () => {
    const { getEditor } = mountEditor(
      docWithInline({
        componentName: 'Mirror',
        sourceRaw: '<Mirror src="pricing" anchor="plans" />',
        attributes: [
          { type: 'mdxJsxAttribute', name: 'src', value: 'pricing' },
          { type: 'mdxJsxAttribute', name: 'anchor', value: 'plans' },
        ],
        props: { src: 'pricing', anchor: 'plans' },
      }),
    );
    await waitFor(() => {
      expect(document.querySelector('[data-jsx-inline-widget]')?.textContent).toContain(
        'pricing#plans',
      );
    });
    const editor = getEditor();
    editor.commands.setNodeSelection(1 + 'before '.length);

    const nameField = await screen.findByDisplayValue('plans');
    fireEvent.change(nameField, { target: { value: 'faq' } });

    await waitFor(() => {
      const saved = getSharedMarkdownManager().serialize(editor.getJSON());
      expect(saved).toContain('<Mirror src="pricing" name="faq" />');
      expect(saved).not.toContain('anchor=');
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
