import { cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared';
import { getSharedMarkdownManager } from '../utils/md-singleton.ts';
import { applySlashCommandItem } from './apply-item';
import { getComponentItems } from './component-items';

function mountEditor(headingText: string | null): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const content = [
    ...(headingText === null
      ? []
      : [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: headingText }] }]),
    { type: 'paragraph' },
  ];
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: { type: 'doc', content },
  });
  return { editor, container };
}

async function insertMirrorSourceAtEnd(editor: Editor): Promise<void> {
  const item = getComponentItems().find((candidate) => candidate.name === 'component-MirrorSource');
  if (!item) throw new Error('no Mirror Source slash item');
  editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' });
  editor.commands.focus('end');
  const from = editor.state.selection.from;
  editor.commands.insertContent('/mirrorsource');
  applySlashCommandItem({ editor, item, range: { from, to: editor.state.selection.from } });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function savedMarkdown(editor: Editor): string {
  return getSharedMarkdownManager().serialize(editor.getJSON());
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('inserting a Mirror Source from the slash menu', () => {
  test('names it after the heading above', async () => {
    const { editor } = mountEditor('Plans');
    try {
      await insertMirrorSourceAtEnd(editor);
      expect(savedMarkdown(editor)).toContain('<MirrorSource name="plans">');
    } finally {
      editor.destroy();
    }
  });

  test('a second one under the same heading gets its own name', async () => {
    const { editor } = mountEditor('Plans');
    try {
      await insertMirrorSourceAtEnd(editor);
      await insertMirrorSourceAtEnd(editor);
      const saved = savedMarkdown(editor);
      expect(saved).toMatch(/^<MirrorSource name="plans">$/m);
      expect(saved).toMatch(/^<MirrorSource name="plans-1">$/m);
    } finally {
      editor.destroy();
    }
  });

  test('without a heading above, it is named `source`', async () => {
    const { editor } = mountEditor(null);
    try {
      await insertMirrorSourceAtEnd(editor);
      expect(savedMarkdown(editor)).toContain('<MirrorSource name="source">');
    } finally {
      editor.destroy();
    }
  });
});
