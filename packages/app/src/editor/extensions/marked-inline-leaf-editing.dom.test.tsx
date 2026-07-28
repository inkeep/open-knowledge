/**
 * WYSIWYG edit- and create-path coverage for emphasis marks on inline leaf nodes.
 *
 * The Yjs-bridge fix preserves a mark on an inline leaf (wikiLink, image, ...)
 * through the storage round-trip, but that is a rung below the editor: it never
 * dispatches a ProseMirror transaction. If the PM schema still forbids the mark
 * (`allowsMarkType === false`), a real editing transaction can normalize it away
 * and the bridge then faithfully persists the stripped result — the loss returns
 * via the edit path — and a user cannot apply the mark at all (`toggleBold`
 * no-ops on the node). This suite drives a real `Editor` in jsdom and asserts the
 * mark survives representative edits and can be created, which the storage-round-
 * trip tests (`conversion-fidelity`, `invariant-i5`, `marked-inline-leaf-bridge`)
 * structurally cannot see. Undo-survival is deliberately not tested here:
 * production undo is Yjs/Collaboration-backed, so its fidelity lives in the
 * two-client `marked-inline-leaf-collab.test.ts`, not a plain history plugin.
 *
 * Marks are mdast-canonical here: `strong` (Cmd+B / toggleBold) and `emphasis`.
 */

// `cleanup` satisfies the Tier-3 filename contract (every `*.dom.test.tsx` must
// value-import from `@testing-library/react`); the suite builds the Editor
// directly and tears it down in `afterEach`.
import { cleanup } from '@testing-library/react';
import { Editor, type JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';

/** A representative inline leaf seed: node type + minimal attrs to construct it. */
interface LeafSeed {
  nodeName: string;
  attrs: Record<string, unknown>;
}

// wikiLink is the originally reported case; image proves the fix generalizes past it.
// The other leaves (tag/mathInline/imageReference/hardBreak) have their legality
// pinned in core `marked-inline-leaf-schema.test.ts` and their storage round-trip
// in the fidelity suites — the edit-path behavior is a property of "inline leaf
// with an empty mark set", identical across them, so it is proven on these two.
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

/** A paragraph of `lead <leaf> trail`, with the leaf carrying the given marks. */
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

/** Document position of the first node of `nodeName`, or -1. */
function posOf(editor: Editor, nodeName: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === nodeName) found = pos;
    return found < 0;
  });
  return found;
}

/** Mark type-names carried by the first node of `nodeName`, or null if absent. */
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
    // Baseline: constructing the doc with the mark keeps it (Node.fromJSON does
    // not validate). If this ever fails, the seed itself is being normalized and
    // the edit assertions below would be testing nothing.
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

  // Create path: select an unmarked wikilink and hit Cmd+B (toggleBold → strong).
  // A user can only bold a wikilink if the schema allows the mark on the node.
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

  // Removal path: the mirror of the create path. Select a strong-marked
  // wikilink and hit Cmd+B — the mark must toggle back OFF. A schema that made
  // the mark legal for adding but left it stuck-on would be a worse bug than
  // the original loss, so the removal direction is pinned independently.
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
