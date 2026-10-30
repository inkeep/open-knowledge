import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { type Editor, mergeAttributes, Node } from '@tiptap/core';
import {
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
  useEditor,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Activity, type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { EditorContent } from './EditorContent';

const blockViewEffects: string[] = [];

function BlockView({ node }: ReactNodeViewProps) {
  useEffect(() => {
    blockViewEffects.push('mount');
    return () => {
      blockViewEffects.push('unmount');
    };
  }, []);
  return <NodeViewWrapper data-testid="block-view">{node.attrs.label}</NodeViewWrapper>;
}

const ViewBlock = Node.create({
  name: 'viewBlock',
  group: 'block',
  atom: true,
  addAttributes: () => ({ label: { default: 'block view' } }),
  parseHTML: () => [{ tag: 'view-block' }],
  renderHTML: ({ HTMLAttributes }) => ['view-block', mergeAttributes(HTMLAttributes)],
  addNodeView: () => ReactNodeViewRenderer(BlockView),
});

function Host({
  visible,
  contentKey = 0,
  show = 'first',
  mounted = true,
}: {
  visible: boolean;
  contentKey?: number;
  show?: 'first' | 'second';
  mounted?: boolean;
}) {
  const first = useEditor({
    extensions: [StarterKit, ViewBlock],
    content: '<p>First document</p><view-block></view-block>',
    immediatelyRender: true,
  });
  const second = useEditor({
    extensions: [StarterKit, ViewBlock],
    content: '<p>Second document</p>',
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));

  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);

  return (
    <Activity mode={visible ? 'visible' : 'hidden'}>
      {mounted &&
        createPortal(
          // oxlint-disable-next-line ok/no-unportaled-editor-content -- portalled per the H6 contract, into a per-render exclusive target
          <EditorContent key={contentKey} editor={show === 'first' ? first : second} />,
          portalTarget,
        )}
    </Activity>
  );
}

function TabActivity({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <Activity mode={visible ? 'visible' : 'hidden'}>{children}</Activity>;
}

function EditorPane({ onEditor }: { onEditor: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [StarterKit, ViewBlock],
    content: '<p>First document</p><view-block></view-block>',
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));

  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);

  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);

  return createPortal(
    // oxlint-disable-next-line ok/no-unportaled-editor-content -- portalled per the H6 contract, into a per-render exclusive target
    <EditorContent editor={editor} />,
    portalTarget,
  );
}

function relabelBlocks(editor: Editor, label: string): void {
  editor.commands.command(({ tr }) => {
    tr.doc.descendants((node, pos) => {
      if (node.type.name === 'viewBlock') tr.setNodeMarkup(pos, undefined, { label });
    });
    return true;
  });
}

describe('EditorContent', () => {
  afterEach(() => {
    cleanup();
    blockViewEffects.length = 0;
  });

  test('keeps block views when its tab is hidden and shown again', async () => {
    const { rerender } = render(<Host visible />);
    const view = await screen.findByTestId('block-view');

    rerender(<Host visible={false} />);
    rerender(<Host visible />);

    expect(await screen.findByTestId('block-view')).toBe(view);
  });

  test('shows a block view that changed while its tab was hidden', async () => {
    const editors: Editor[] = [];
    const pane = <EditorPane onEditor={(editor) => editors.push(editor)} />;
    const { rerender } = render(<TabActivity visible>{pane}</TabActivity>);
    expect((await screen.findByTestId('block-view')).textContent).toBe('block view');

    rerender(<TabActivity visible={false}>{pane}</TabActivity>);
    act(() => relabelBlocks(editors[0] as Editor, 'changed while hidden'));
    rerender(<TabActivity visible>{pane}</TabActivity>);

    await waitFor(() =>
      expect(screen.getByTestId('block-view').textContent).toBe('changed while hidden'),
    );
  });

  test('shows a block view inserted while its tab was hidden', async () => {
    const editors: Editor[] = [];
    const pane = <EditorPane onEditor={(editor) => editors.push(editor)} />;
    const { rerender } = render(<TabActivity visible>{pane}</TabActivity>);
    await screen.findByTestId('block-view');

    rerender(<TabActivity visible={false}>{pane}</TabActivity>);
    await act(async () => {
      editors[0]?.commands.insertContentAt(0, { type: 'viewBlock', attrs: { label: 'inserted' } });
    });
    rerender(<TabActivity visible>{pane}</TabActivity>);

    await waitFor(() =>
      expect(screen.getAllByTestId('block-view').map((view) => view.textContent)).toEqual([
        'inserted',
        'block view',
      ]),
    );
  });

  test('builds the editor again for a new EditorContent of the same editor', async () => {
    const { rerender } = render(<Host visible contentKey={1} />);
    await screen.findByTestId('block-view');

    rerender(<Host visible contentKey={2} />);

    expect(await screen.findByTestId('block-view')).not.toBeNull();
    expect(screen.getByText('First document')).not.toBeNull();
  });

  test('mounts each block view once when a new EditorContent reopens the editor', async () => {
    const { rerender } = render(<Host visible contentKey={1} />);
    await screen.findByTestId('block-view');
    rerender(<Host visible contentKey={1} mounted={false} />);
    blockViewEffects.length = 0;

    rerender(<Host visible contentKey={2} />);

    expect(await screen.findByTestId('block-view')).not.toBeNull();
    expect(blockViewEffects).toEqual(['mount']);
  });

  test('shows only the editor it is given', async () => {
    const { rerender } = render(<Host visible />);
    await screen.findByText('First document');

    rerender(<Host visible show="second" />);

    expect(await screen.findByText('Second document')).not.toBeNull();
    expect(screen.queryByText('First document')).toBeNull();
  });
});
