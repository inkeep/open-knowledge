import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

const PRIOR_SOURCE_RAW = '<img src="prior-marker.png" />';

const PRIOR_POS = 0;

interface SuggestionPluginState {
  active: boolean;
}

function getSlashState(editor: Editor): SuggestionPluginState | null {
  const plugin = editor.state.plugins.find((p) => {
    const keyName = (p as { spec?: { key?: { key?: string } } }).spec?.key?.key;
    return typeof keyName === 'string' && keyName.startsWith('slashCommand');
  });
  return (plugin?.getState(editor.state) as SuggestionPluginState | undefined) ?? null;
}

function mountEditorWithPriorComponent(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: {
      type: 'doc',
      content: [
        {
          type: 'jsxComponent',
          attrs: {
            componentName: 'img',
            kind: 'element',
            attributes: [],
            sourceRaw: PRIOR_SOURCE_RAW,
            sourceDirty: false,
            props: { src: 'prior-marker.png' },
          },
        },
        { type: 'paragraph' },
      ],
    },
  });
  return { editor, container };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
  for (const node of Array.from(document.body.children)) {
    if (node !== container) node.remove();
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function openSlashMenu(editor: Editor): Promise<void> {
  editor.commands.focus('end');
  editor.commands.insertContent('/image');
  await flush();
  expect(getSlashState(editor)?.active).toBe(true);
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return editor.view.someProp('handleKeyDown', (f) => f(editor.view, event)) === true;
}

function jsxComponentSourceRaws(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'jsxComponent') out.push(String(node.attrs.sourceRaw));
  });
  return out;
}

describe('Slash-command insertion is a single transaction', () => {
  afterEach(() => {
    cleanup();
  });

  test('running a slash-command item dispatches exactly one doc-changing transaction', async () => {
    const { editor, container } = mountEditorWithPriorComponent();
    try {
      await openSlashMenu(editor);

      let docChangingCount = 0;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) docChangingCount += 1;
      });

      expect(pressEnter(editor)).toBe(true);
      await flush();

      expect(jsxComponentSourceRaws(editor)).toHaveLength(2);

      expect(docChangingCount).toBe(1);
    } finally {
      teardown(editor, container);
    }
  });

  test('a transaction interleaved mid-command cannot divert the insert onto a prior node', async () => {
    const { editor, container } = mountEditorWithPriorComponent();
    try {
      await openSlashMenu(editor);

      let interleaved = false;
      editor.on('transaction', ({ transaction }) => {
        if (interleaved || !transaction.docChanged) return;
        interleaved = true;
        const { state, dispatch } = editor.view;
        dispatch(state.tr.setSelection(NodeSelection.create(state.doc, PRIOR_POS)));
      });

      expect(pressEnter(editor)).toBe(true);
      await flush();

      expect(interleaved).toBe(true);

      const sourceRaws = jsxComponentSourceRaws(editor);
      expect(sourceRaws).toHaveLength(2);
      expect(sourceRaws).toContain(PRIOR_SOURCE_RAW);
    } finally {
      teardown(editor, container);
    }
  });
});
