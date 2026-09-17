import {
  getParseHealth,
  MarkdownManager,
  resetParseHealth,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { StrictMode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Toaster, toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JsxComponent } from './jsx-component';
import { SelectionStatePlugin } from './selection-state-plugin';
import { SourceDirtyObserver } from './source-dirty-observer';

const manager = new MarkdownManager({ extensions: sharedExtensions });
const extensions = [
  ...sharedExtensions.map((extension) =>
    extension.name === 'jsxComponent' ? JsxComponent : extension,
  ),
  SourceDirtyObserver,
  SelectionStatePlugin,
];

function Host({ source, onEditor }: { source: string; onEditor: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions,
    content: manager.parse(source),
    immediatelyRender: false,
    onCreate: ({ editor: createdEditor }) => onEditor(createdEditor),
  });
  const [target] = useState(() => document.createElement('div'));
  useEffect(() => {
    document.body.appendChild(target);
    return () => target.remove();
  }, [target]);
  return createPortal(
    // oxlint-disable-next-line ok/no-unportaled-editor-content -- Each test editor owns its portal target.
    <EditorContent editor={editor} />,
    target,
  );
}

async function mountEditor(source: string): Promise<Editor> {
  let editor: Editor | undefined;
  render(
    <StrictMode>
      <Host
        source={source}
        onEditor={(value) => {
          editor = value;
        }}
      />
      <Toaster />
    </StrictMode>,
  );
  await waitFor(() => expect(editor).toBeDefined());
  if (!editor) throw new Error('editor not mounted');
  return editor;
}

beforeEach(() => {
  expect(document.querySelector('.ProseMirror')).toBeNull();
  resetParseHealth();
});

afterEach(() => {
  toast.dismiss();
  vi.useRealTimers();
});

describe('unknown component conversion', () => {
  test.each([
    {
      name: 'adjacent components that expand when converted to source',
      blocks: [
        '<Badge>\nDefault\n</Badge>',
        '<Badge variant="accent">\nPreview\n</Badge>',
        '<Badge variant="success">\nStable\n</Badge>',
      ],
    },
    {
      name: 'nested components and their following siblings',
      blocks: [
        '<CardGroup cols={2}>\n<Card title="Quick start">\nFirst page.\n</Card>\n<Card title="Components">\nUseful documentation.\n</Card>\n</CardGroup>',
        '<Icon icon="book-open" size={32} />',
      ],
    },
  ])('preserves all source bytes for $name', async ({ blocks }) => {
    const source = `# Before\n\n${blocks.join('\n\n')}\n\n## After\n\nKeep this paragraph.\n`;
    const editor = await mountEditor(source);

    await waitFor(() => {
      const fallbacks: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'rawMdxFallback') fallbacks.push(node.textContent);
      });
      expect(fallbacks).toEqual(blocks);
    });
    expect(manager.serialize(editor.getJSON())).toBe(source);
  });

  test('converts a value-equal replacement while its node view is reused', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const source = '<Badge>\nDefault\n</Badge>\n';
    const editor = await mountEditor(source);
    const original = editor.state.doc.child(0);
    const replacement = editor.schema.nodeFromJSON(original.toJSON());
    expect(replacement).not.toBe(original);
    expect(replacement.eq(original)).toBe(true);

    act(() => {
      editor.view.dispatch(editor.state.tr.replaceWith(0, original.nodeSize, replacement));
    });
    expect(editor.state.doc.child(0)).toBe(replacement);
    act(() => vi.advanceTimersToNextFrame());

    expect(editor.state.doc.child(0).type.name).toBe('rawMdxFallback');
    expect(manager.serialize(editor.getJSON())).toBe(source);
  });

  test('converts the latest source when the node changes before the scheduled frame', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const editor = await mountEditor('<Badge>\nDefault\n</Badge>\n');
    const replacement = editor.schema
      .nodeFromJSON(manager.parse('<Badge>\nUpdated\n</Badge>\n'))
      .child(0);

    act(() => {
      editor.view.dispatch(
        editor.state.tr.replaceWith(0, editor.state.doc.child(0).nodeSize, replacement),
      );
      vi.advanceTimersToNextFrame();
    });
    const edited = manager.serialize(editor.getJSON());
    act(() => vi.advanceTimersToNextFrame());

    expect(editor.state.doc.child(0).type.name).toBe('rawMdxFallback');
    expect(editor.state.doc.child(0).textContent).toContain('Updated');
    expect(manager.serialize(editor.getJSON())).toBe(edited);
    expect(getParseHealth().jsxAutoConvertFailed).toEqual({});
    expect(getParseHealth().jsxActionAborted).toEqual({});
  });

  test('does not restore a node deleted before the scheduled frame', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const editor = await mountEditor('<Badge>\nDefault\n</Badge>\n\nKeep this paragraph.\n');

    act(() => {
      editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
      vi.advanceTimersToNextFrame();
    });

    expect(manager.serialize(editor.getJSON())).toBe('Keep this paragraph.\n');
    expect(getParseHealth().jsxAutoConvertFailed).toEqual({});
    expect(getParseHealth().jsxActionAborted).toEqual({});
  });
});

describe('component actions before the shifted position renders', () => {
  test('deletes the clicked component without deleting its preceding text', async () => {
    const component = '<Callout title="Target">\nKeep the neighbors.\n</Callout>';
    const source = `Before.\n\n${component}\n\nAfter.\n`;
    const editor = await mountEditor(source);
    const button = screen.getByRole('button', { name: 'Delete Callout', exact: true });

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('Shifted ', 1));
      fireEvent.click(button);
    });

    expect(manager.serialize(editor.getJSON())).toBe('Shifted Before.\n\nAfter.\n');
  });

  test.each(['up', 'down'] as const)(
    'moves the clicked component %s after a position shift',
    async (direction) => {
      const first = '<Callout title="First">\nFirst body.\n</Callout>';
      const second = '<Callout title="Second">\nSecond body.\n</Callout>';
      const source = `Before.\n\n<Callout title="Group">\n${first}\n${second}\n</Callout>\n\nAfter.\n`;
      const editor = await mountEditor(source);
      const button = screen.getByRole('button', { name: `Move ${direction}`, exact: true });

      act(() => {
        editor.view.dispatch(editor.state.tr.insertText('Shifted ', 1));
        fireEvent.click(button);
      });

      expect(editor.state.doc.child(0).textContent).toBe('Shifted Before.');
      const group = editor.state.doc.child(1);
      expect(group.child(0).textContent).toBe('Second body.');
      expect(group.child(1).textContent).toBe('First body.');
      expect(editor.state.doc.child(2).textContent).toBe('After.');
    },
  );

  test('selects the clicked component for a comment after a position shift', async () => {
    const source = 'Before.\n\n<Math formula="x^2" />\n\nAfter.\n';
    const editor = await mountEditor(source);
    const target = editor.state.doc.child(1);
    const button = screen.getByRole('button', {
      name: 'Comment or ask AI about this Math',
      exact: true,
    });

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText('Shifted ', 1));
      fireEvent.click(button);
    });

    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize);
    expect(editor.state.doc.nodeAt(editor.state.selection.from)).toBe(target);
    expect(manager.serialize(editor.getJSON())).toBe(source.replace('Before.', 'Shifted Before.'));
  });

  test('updates move-button availability when an unchanged child changes position', async () => {
    const editor = await mountEditor(
      '<Callout title="Group">\n<Callout title="First">\nFirst body.\n</Callout>\n<Callout title="Second">\nSecond body.\n</Callout>\n</Callout>\n',
    );
    const first = editor.state.doc.child(0).child(0);
    const second = editor.state.doc.child(0).child(1);
    expect(screen.getByRole('button', { name: 'Move up', exact: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move down', exact: true })).toBeTruthy();

    act(() => editor.view.dispatch(editor.state.tr.delete(1, 1 + first.nodeSize)));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Move up', exact: true })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Move down', exact: true })).toBeNull();
    });
    expect(editor.state.doc.child(0).child(0)).toBe(second);
  });

  test('acknowledges a delete aborted because the component changed', async () => {
    const warn = vi.spyOn(console, 'warn');
    const editor = await mountEditor('<Callout title="Target">\nOriginal body.\n</Callout>\n');
    const button = screen.getByRole('button', { name: 'Delete Callout', exact: true });
    const replacement = editor.schema
      .nodeFromJSON(manager.parse('<Callout title="Target">\nNew body.\n</Callout>\n'))
      .child(0);

    act(() => {
      editor.view.dispatch(
        editor.state.tr.replaceWith(0, editor.state.doc.child(0).nodeSize, replacement),
      );
      fireEvent.click(button);
    });

    expect(editor.state.doc.child(0).textContent).toBe('New body.');
    expect(await screen.findByText('This component changed. Try again.')).toBeTruthy();
    expect(getParseHealth().jsxActionAborted).toEqual({ 'delete-chrome': 1 });
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'jsx-component-action-aborted',
        action: 'delete-chrome',
        reason: 'changed',
        component: 'Callout',
        rawComponentName: 'Callout',
      }),
    );
    warn.mockRestore();
  });

  test('does not insert a child at document start after its parent is removed', async () => {
    const editor = await mountEditor(
      '<Tabs>\n<Tab label="First">\nFirst body.\n</Tab>\n</Tabs>\n\nKeep this paragraph.\n',
    );
    const button = screen.getByRole('button', { name: 'Add tab', exact: true });

    act(() => {
      editor.view.dispatch(editor.state.tr.delete(0, editor.state.doc.child(0).nodeSize));
      fireEvent.click(button);
    });

    expect(manager.serialize(editor.getJSON())).toBe('Keep this paragraph.\n');
    expect(await screen.findByText('This component was removed.')).toBeTruthy();
    expect(getParseHealth().jsxActionAborted).toEqual({ 'insert-child': 1 });
  });

  test('attributes a stale keyboard delete to the keyboard entry point', async () => {
    const warn = vi.spyOn(console, 'warn');
    const editor = await mountEditor('<Callout title="Target">\nOriginal body.\n</Callout>\n');
    act(() => {
      editor.commands.setNodeSelection(0);
    });
    const wrapper = document.querySelector('[data-component-name="Callout"][data-selected="true"]');
    if (!wrapper) throw new Error('selected component wrapper not found');
    const replacement = editor.schema
      .nodeFromJSON(manager.parse('<Callout title="Target">\nNew body.\n</Callout>\n'))
      .child(0);

    act(() => {
      editor.view.dispatch(
        editor.state.tr.replaceWith(0, editor.state.doc.child(0).nodeSize, replacement),
      );
      fireEvent.keyDown(wrapper, { key: 'Backspace' });
    });

    expect(editor.state.doc.child(0).textContent).toBe('New body.');
    expect(getParseHealth().jsxActionAborted).toEqual({ 'delete-keyboard': 1 });
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'jsx-component-action-aborted',
        action: 'delete-keyboard',
        reason: 'changed',
        component: 'Callout',
        rawComponentName: 'Callout',
      }),
    );
    warn.mockRestore();
  });

  test('merges a property edit with other live property changes', async () => {
    const editor = await mountEditor('<Callout title="Original">\nBody.\n</Callout>\n');
    fireEvent.click(screen.getByRole('button', { name: 'Callout properties', exact: true }));
    const title = await screen.findByDisplayValue('Original');

    act(() => {
      const node = editor.state.doc.child(0);
      editor.view.dispatch(
        editor.state.tr.setNodeAttribute(0, 'props', { ...node.attrs.props, icon: 'sparkles' }),
      );
      fireEvent.change(title, { target: { value: 'Updated title' } });
    });

    expect(editor.state.doc.child(0).attrs.props).toMatchObject({
      title: 'Updated title',
      icon: 'sparkles',
    });
    expect(getParseHealth().jsxActionAborted).toEqual({});
  });
});
