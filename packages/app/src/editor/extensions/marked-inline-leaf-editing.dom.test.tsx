import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

interface LeafSeed {
  nodeName: string;
  attrs: Record<string, unknown>;
}

const LEAF_SEEDS: LeafSeed[] = [
  { nodeName: 'wikiLink', attrs: { target: 'Alpha' } },
  { nodeName: 'image', attrs: { src: 'pic.png', alt: 'pic' } },
];

function mount(content: JSONContent): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content,
  });
  return { editor, container };
}

function paragraphWithLeaf(seed: LeafSeed, markNames: string[]): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'lead ' },
          { type: seed.nodeName, attrs: seed.attrs, marks: markNames.map((m) => ({ type: m })) },
          { type: 'text', text: ' trail' },
        ],
      },
    ],
  };
}

function teardown(editor: Editor, container: HTMLDivElement): void {
  editor.destroy();
  container.remove();
}

function posOf(editor: Editor, nodeName: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === nodeName) found = pos;
    return found < 0;
  });
  return found;
}

function marksOnLeaf(editor: Editor, nodeName: string): string[] | null {
  let marks: string[] | null = null;
  editor.state.doc.descendants((node) => {
    if (marks === null && node.type.name === nodeName) marks = node.marks.map((m) => m.type.name);
    return marks === null;
  });
  return marks;
}

describe('emphasis marks on inline leaf nodes survive WYSIWYG editing', () => {
  afterEach(() => {
    cleanup();
  });

  for (const seed of LEAF_SEEDS) {
    test(`${seed.nodeName}: seeded strong mark is present`, () => {
      const { editor, container } = mount(paragraphWithLeaf(seed, ['strong']));
      try {
        expect(marksOnLeaf(editor, seed.nodeName)).toContain('strong');
      } finally {
        teardown(editor, container);
      }
    });

    test(`${seed.nodeName}: strong survives typing after the node`, () => {
      const { editor, container } = mount(paragraphWithLeaf(seed, ['strong']));
      try {
        editor.commands.insertContentAt(posOf(editor, seed.nodeName) + 1, 'X');
        expect(marksOnLeaf(editor, seed.nodeName)).toContain('strong');
      } finally {
        teardown(editor, container);
      }
    });

    test(`${seed.nodeName}: strong survives typing before the node`, () => {
      const { editor, container } = mount(paragraphWithLeaf(seed, ['strong']));
      try {
        editor.commands.insertContentAt(posOf(editor, seed.nodeName), 'X');
        expect(marksOnLeaf(editor, seed.nodeName)).toContain('strong');
      } finally {
        teardown(editor, container);
      }
    });

    test(`${seed.nodeName}: strong survives splitting the paragraph after the node`, () => {
      const { editor, container } = mount(paragraphWithLeaf(seed, ['strong']));
      try {
        editor
          .chain()
          .setTextSelection(posOf(editor, seed.nodeName) + 1)
          .splitBlock()
          .run();
        expect(marksOnLeaf(editor, seed.nodeName)).toContain('strong');
      } finally {
        teardown(editor, container);
      }
    });
  }

  test('wikiLink: pre-existing emphasis and strong coexist through an edit', () => {
    const { editor, container } = mount(paragraphWithLeaf(LEAF_SEEDS[0], ['strong', 'emphasis']));
    try {
      editor.commands.insertContentAt(posOf(editor, 'wikiLink') + 1, 'X');
      const marks = marksOnLeaf(editor, 'wikiLink');
      expect(marks).toContain('strong');
      expect(marks).toContain('emphasis');
    } finally {
      teardown(editor, container);
    }
  });

  test('wikiLink: toggleBold applies strong to a selected unmarked node (create path)', () => {
    const { editor, container } = mount(paragraphWithLeaf(LEAF_SEEDS[0], []));
    try {
      const pos = posOf(editor, 'wikiLink');
      const { state } = editor.view;
      editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
      editor.commands.toggleBold();
      expect(marksOnLeaf(editor, 'wikiLink')).toContain('strong');
    } finally {
      teardown(editor, container);
    }
  });

  test('wikiLink: toggleBold removes strong from a selected marked node (removal path)', () => {
    const { editor, container } = mount(paragraphWithLeaf(LEAF_SEEDS[0], ['strong']));
    try {
      const pos = posOf(editor, 'wikiLink');
      const { state } = editor.view;
      editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
      editor.commands.toggleBold();
      expect(marksOnLeaf(editor, 'wikiLink')).not.toContain('strong');
    } finally {
      teardown(editor, container);
    }
  });
});
