import type { HocuspocusProvider } from '@hocuspocus/provider';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  createProjectionBinding,
  mapOffsetThroughDelta,
  narrowSplice,
  type ProjectionBinding,
} from './projection-binding';
import { sharedUndoManagerFor } from './shared-undo-manager';
import { buildExtensionList, buildPatternDConstructorOptions } from './TiptapEditor';
import { fakeClipboard, installDomGlobals } from './walk-currency-test-harness';

const md = new MarkdownManager({ extensions: sharedExtensions });
const projectionMd = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

let restoreDom: (() => void) | undefined;
beforeAll(() => {
  restoreDom = installDomGlobals();
});
afterAll(() => {
  restoreDom?.();
});

const USER_ORIGIN = Symbol('local-user');

interface Rig {
  editor: Editor;
  ytext: Y.Text;
  ydoc: Y.Doc;
  stats: ProjectionBinding['stats'];
  destroy(): void;
}

function createRig(source: string): Rig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');
  return createRigOn(ydoc);
}

function createRigOn(ydoc: Y.Doc): Rig {
  const ytext = ydoc.getText('source');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const binding = createProjectionBinding({ ytext, md: projectionMd, origin: USER_ORIGIN });
  const editor = new Editor({
    element: host,
    content: binding.content,
    extensions: [...sharedExtensions, binding.extension],
  });
  return {
    editor,
    ytext,
    ydoc,
    stats: binding.stats,
    destroy() {
      editor.destroy();
      host.remove();
      ydoc.destroy();
    },
  };
}

function appendToBlock(editor: Editor, blockIndex: number, text: string): void {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i <= blockIndex; i++) pos += doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.insertText(text, pos - 1, pos - 1));
}

const DOC = '# Heading\n\nA paragraph with [**Desktop**](x) inside.\n\n- one\n- two\n\nTail.\n';

describe('projection binding — the editor is a read model of Y.Text', () => {
  it('projects the markdown into the document on attach', () => {
    const rig = createRig(DOC);
    expect(rig.editor.state.doc.childCount).toBe(4);
    expect(rig.editor.state.doc.child(0).type.name).toBe('heading');
    expect(rig.editor.state.doc.child(0).textContent).toBe('Heading');
    expect(rig.editor.state.doc.child(2).type.name).toBe('list');
    rig.destroy();
  });

  it('projects an empty document without throwing', () => {
    const rig = createRig('');
    expect(rig.editor.state.doc.childCount).toBe(1);
    rig.destroy();
  });
});

describe('projection binding — WYSIWYG edits write Y.Text under the user origin', () => {
  it('carries a keystroke into Y.Text', () => {
    const rig = createRig(DOC);
    appendToBlock(rig.editor, 3, '!');
    expect(rig.ytext.toString()).toBe(DOC.replace('Tail.', 'Tail.!'));
    rig.destroy();
  });

  it('stamps the write with the user origin, not a sync origin', () => {
    const rig = createRig(DOC);
    const origins: unknown[] = [];
    rig.ytext.observe((_event, transaction) => origins.push(transaction.origin));
    appendToBlock(rig.editor, 0, '!');
    expect(origins).toEqual([USER_ORIGIN]);
    rig.destroy();
  });

  it('touches only the edited block — an untouched block keeps its authored bytes', () => {
    const rig = createRig(DOC);
    appendToBlock(rig.editor, 0, ' edited');
    const after = rig.ytext.toString();
    expect(after).toContain('[**Desktop**](x)');
    expect(after).not.toContain('**[Desktop](x)**');
    expect(after).toContain('# Heading edited');
    expect(after.slice(after.indexOf('A paragraph'))).toBe(DOC.slice(DOC.indexOf('A paragraph')));
    rig.destroy();
  });

  it('writes one contiguous delete+insert, never a character-minimal diff', () => {
    const rig = createRig(DOC);
    const deltas: unknown[][] = [];
    rig.ytext.observe((event) => deltas.push(event.changes.delta as unknown[]));
    appendToBlock(rig.editor, 1, ' more');
    expect(deltas).toHaveLength(1);
    const ops = (deltas[0] as Array<Record<string, unknown>>).filter(
      (op) => op.insert !== undefined || op.delete !== undefined,
    );
    expect(ops.filter((op) => op.insert !== undefined)).toHaveLength(1);
    rig.destroy();
  });

  it('survives a run of keystrokes across different blocks', () => {
    const rig = createRig(DOC);
    appendToBlock(rig.editor, 0, 'A');
    appendToBlock(rig.editor, 3, 'B');
    appendToBlock(rig.editor, 0, 'C');
    appendToBlock(rig.editor, 1, 'D');
    const after = rig.ytext.toString();
    expect(after).toContain('# HeadingAC');
    expect(after).toContain('Tail.B');
    expect(after).toContain('inside.D');
    expect(md.parse(after)).toEqual(rig.editor.state.doc.toJSON());
    rig.destroy();
  });
});

function pressEnter(editor: Editor, at: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
  editor.commands.splitBlock();
}

function deleteBlock(editor: Editor, blockIndex: number): void {
  let pos = 0;
  for (let i = 0; i < blockIndex; i++) pos += editor.state.doc.child(i).nodeSize;
  const size = editor.state.doc.child(blockIndex).nodeSize;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + size));
}

function endOfBlock(editor: Editor, blockIndex: number): number {
  let pos = 0;
  for (let i = 0; i <= blockIndex; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos - 1;
}

describe('projection binding — blocks markdown cannot spell', () => {
  it('keeps the empty paragraph Enter creates, and writes no bytes for it', () => {
    const rig = createRig(DOC);
    const before = rig.ytext.toString();
    const blocks = rig.editor.state.doc.childCount;

    pressEnter(rig.editor, endOfBlock(rig.editor, blocks - 1));

    expect(rig.editor.state.doc.childCount).toBe(blocks + 1);
    const added = rig.editor.state.doc.child(blocks);
    expect(added.type.name).toBe('paragraph');
    expect(added.content.size).toBe(0);
    expect(rig.ytext.toString()).toBe(before);
    rig.destroy();
  });

  it('materializes the block into markdown as soon as it has content', () => {
    const rig = createRig(DOC);
    pressEnter(rig.editor, endOfBlock(rig.editor, rig.editor.state.doc.childCount - 1));
    rig.editor.commands.insertContent('New paragraph.');

    expect(rig.ytext.toString()).toBe(`${DOC}\nNew paragraph.\n`);
    expect(md.parse(rig.ytext.toString())).toEqual(rig.editor.state.doc.toJSON());
    rig.destroy();
  });

  it('splits a paragraph in two when Enter lands mid-block', () => {
    const rig = createRig('# H\n\nhelloworld\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 1) - 'world'.length);

    expect(rig.editor.state.doc.childCount).toBe(3);
    expect(rig.ytext.toString()).toBe('# H\n\nhello\n\nworld\n');
    rig.destroy();
  });

  it('preserves a leading space when a split creates one', () => {
    const rig = createRig('# H\n\nhello world\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 1) - ' world'.length);
    expect(rig.ytext.toString()).toBe('# H\n\nhello\n\n&#x20;world\n');
    const reparsed = rig.editor.state.doc.type.schema.nodeFromJSON(md.parse(rig.ytext.toString()));
    expect(reparsed.childCount).toBe(rig.editor.state.doc.childCount);
    expect(reparsed.textContent).toBe(rig.editor.state.doc.textContent);
    rig.destroy();
  });

  it('survives Enter, typing, Enter, typing', () => {
    const rig = createRig('# H\n\nfirst\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 1));
    rig.editor.commands.insertContent('second');
    pressEnter(rig.editor, endOfBlock(rig.editor, 2));
    rig.editor.commands.insertContent('third');

    expect(rig.ytext.toString()).toBe('# H\n\nfirst\n\nsecond\n\nthird\n');
    expect(md.parse(rig.ytext.toString())).toEqual(rig.editor.state.doc.toJSON());
    rig.destroy();
  });

  it('removes an empty paragraph again without touching the bytes', () => {
    const rig = createRig(DOC);
    const before = rig.ytext.toString();
    const blocks = rig.editor.state.doc.childCount;
    pressEnter(rig.editor, endOfBlock(rig.editor, blocks - 1));
    expect(rig.editor.state.doc.childCount).toBe(blocks + 1);

    rig.editor.commands.undo?.();
    const size = rig.editor.state.doc.content.size;
    const lastSize = rig.editor.state.doc.child(rig.editor.state.doc.childCount - 1).nodeSize;
    if (rig.editor.state.doc.childCount > blocks) {
      rig.editor.view.dispatch(rig.editor.state.tr.delete(size - lastSize, size));
    }
    expect(rig.editor.state.doc.childCount).toBe(blocks);
    expect(rig.ytext.toString()).toBe(before);
    rig.destroy();
  });

  it('writes an interior blank run as the wider gap markdown spells it with', () => {
    const rig = createRig('a\n\nb\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\nb\n');

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\nb\n');

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\n\nb\n');

    expect(md.parse(rig.ytext.toString()).content).toHaveLength(5);
    rig.destroy();
  });

  it('writes a trailing blank run only from the doc-edge floor up', () => {
    const rig = createRig('a\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n');
    expect(rig.editor.state.doc.childCount).toBe(2);

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\n');
    rig.destroy();
  });

  it('round-trips a blank run through a re-projection', () => {
    const rig = createRig('a\n\nb\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    const source = rig.ytext.toString();

    const reprojected = md.parse(source) as { content: unknown[] };
    expect(reprojected.content).toHaveLength(rig.editor.state.doc.childCount);
    expect(source).toBe('a\n\n\n\nb\n');
    rig.destroy();
  });

  it('removes an interior blank line again when it is deleted', () => {
    const rig = createRig('a\n\n\n\n\nb\n');
    expect(rig.editor.state.doc.childCount).toBe(5);

    for (const expected of ['a\n\n\n\nb\n', 'a\n\n\nb\n', 'a\n\nb\n']) {
      deleteBlock(rig.editor, 1);
      expect(rig.ytext.toString()).toBe(expected);
      expect((md.parse(rig.ytext.toString()) as { content: unknown[] }).content).toHaveLength(
        rig.editor.state.doc.childCount,
      );
    }
    rig.destroy();
  });

  it('collapses a trailing run below the floor rather than resurrecting a line', () => {
    const rig = createRig('a\n\n\n\n');
    expect(rig.editor.state.doc.childCount).toBe(4);

    deleteBlock(rig.editor, 1);
    expect(rig.ytext.toString()).toBe('a\n\n\n');

    deleteBlock(rig.editor, 1);
    expect(rig.ytext.toString()).toBe('a\n');
    rig.destroy();
  });

  it('turns a paragraph emptied of its text into a blank line', () => {
    const rig = createRig('a\n\nx\n\nc\n');
    const doc = rig.editor.state.doc;
    const start = doc.child(0).nodeSize;
    rig.editor.view.dispatch(
      rig.editor.state.tr.delete(start + 1, start + doc.child(1).nodeSize - 1),
    );
    expect(rig.ytext.toString()).toBe('a\n\n\nc\n');
    expect(rig.editor.state.doc.childCount).toBe(3);
    rig.destroy();
  });

  it('still deletes a block outright when it holds real content', () => {
    const rig = createRig('a\n\nx\n\nc\n');
    deleteBlock(rig.editor, 1);
    expect(rig.ytext.toString()).toBe('a\n\nc\n');
    expect(rig.editor.state.doc.childCount).toBe(2);
    rig.destroy();
  });

  it('keeps an outside write correct while an unspellable block is held', () => {
    const rig = createRig(DOC);
    pressEnter(rig.editor, endOfBlock(rig.editor, rig.editor.state.doc.childCount - 1));
    rig.ydoc.transact(() => rig.ytext.insert(0, 'Preamble.\n\n'), 'agent');
    expect(rig.editor.state.doc.child(0).textContent).toBe('Preamble.');
    expect(rig.ytext.toString()).toBe(`Preamble.\n\n${DOC}`);

    rig.editor.commands.insertContent('!');
    expect(rig.ytext.toString()).toContain('Preamble.');
    rig.destroy();
  });
});

describe('projection binding — external writes need no derive', () => {
  it('picks up an agent write to Y.Text', () => {
    const rig = createRig(DOC);
    rig.ydoc.transact(() => {
      rig.ytext.insert(rig.ytext.length, '\nAppended by an agent.\n');
    }, 'agent');
    expect(rig.editor.state.doc.childCount).toBe(5);
    expect(rig.editor.state.doc.child(4).textContent).toBe('Appended by an agent.');
    rig.destroy();
  });

  it('re-projects a whole-document replacement (a rollback)', () => {
    const rig = createRig(DOC);
    rig.ydoc.transact(() => {
      rig.ytext.delete(0, rig.ytext.length);
      rig.ytext.insert(0, '# Rolled back\n\nOnly this.\n');
    }, 'rollback');
    expect(rig.editor.state.doc.childCount).toBe(2);
    expect(rig.editor.state.doc.child(0).textContent).toBe('Rolled back');
    rig.destroy();
  });

  it('keeps typing correct after an external write lands underneath it', () => {
    const rig = createRig(DOC);
    rig.ydoc.transact(() => {
      rig.ytext.insert(0, 'Preamble.\n\n');
    }, 'agent');
    expect(rig.editor.state.doc.child(0).textContent).toBe('Preamble.');
    appendToBlock(rig.editor, 1, '!');
    expect(rig.ytext.toString()).toContain('# Heading!');
    expect(rig.ytext.toString()).toContain('Preamble.');
    rig.destroy();
  });

  it('does not echo its own write back as an external change', () => {
    const rig = createRig(DOC);
    let events = 0;
    rig.ytext.observe(() => events++);
    appendToBlock(rig.editor, 0, '!');
    expect(events).toBe(1);
    expect(rig.ytext.toString()).toContain('# Heading!');
    expect(rig.ytext.toString()).not.toContain('!!');
    rig.destroy();
  });
});

describe('projection binding — a keystroke does not re-parse the document', () => {
  it('writes every keystroke and rebuilds for none of them', () => {
    const rig = createRig(DOC);
    const before = rig.stats.rebuilds;
    for (let i = 0; i < 20; i++) appendToBlock(rig.editor, 1, 'x');
    expect(rig.stats.writes).toBe(20);
    expect(rig.stats.rebuilds).toBe(before);
    expect(rig.ytext.toString()).toContain(`inside.${'x'.repeat(20)}`);
    rig.destroy();
  });

  it('pays exactly one parse for an outside write', () => {
    const rig = createRig(DOC);
    const before = rig.stats.rebuilds;
    rig.ydoc.transact(() => rig.ytext.insert(0, 'Preamble.\n\n'), 'agent');
    expect(rig.stats.rebuilds).toBe(before + 1);
    rig.destroy();
  });
});

describe('mapOffsetThroughDelta', () => {
  it('carries an offset past an insertion and a deletion', () => {
    expect(mapOffsetThroughDelta([{ retain: 5 }, { insert: 'abc' }], 10)).toBe(13);
    expect(mapOffsetThroughDelta([{ retain: 5 }, { insert: 'abc' }], 3)).toBe(3);
    expect(mapOffsetThroughDelta([{ retain: 5 }, { delete: 3 }], 10)).toBe(7);
  });

  it('collapses an offset inside a removed run onto its start', () => {
    expect(mapOffsetThroughDelta([{ retain: 5 }, { delete: 4 }], 7)).toBe(5);
  });
});

describe('narrowSplice — one contiguous run, trimmed to the bytes that differ', () => {
  it('keeps a shared prefix out of the run when a block gains a character', () => {
    expect(narrowSplice('one\n\ntwo\n', { from: 5, to: 8, text: 'twoX' })).toEqual({
      from: 8,
      to: 8,
      text: 'X',
    });
  });

  it('keeps a shared suffix out of the run when a block gains a leading character', () => {
    expect(narrowSplice('one\n\ntwo\n', { from: 5, to: 8, text: 'Xtwo' })).toEqual({
      from: 5,
      to: 5,
      text: 'X',
    });
  });

  it('narrows a middle rewrite to the differing span alone', () => {
    expect(narrowSplice('a cat sat\n', { from: 0, to: 9, text: 'a dog sat' })).toEqual({
      from: 2,
      to: 5,
      text: 'dog',
    });
  });

  it('returns an empty run when the splice writes the bytes already present', () => {
    expect(narrowSplice('one\n\ntwo\n', { from: 5, to: 8, text: 'two' })).toEqual({
      from: 8,
      to: 8,
      text: '',
    });
  });

  it('never splits a surrogate pair across the run boundary', () => {
    const before = 'a\u{1F600}b\n';
    const narrowed = narrowSplice(before, { from: 0, to: 4, text: 'a\u{1F601}b' });
    expect(before.slice(0, narrowed.from) + narrowed.text + before.slice(narrowed.to)).toBe(
      'a\u{1F601}b\n',
    );
    expect(narrowed.text).toBe('\u{1F601}');
    expect(narrowed.from).toBe(1);
    expect(narrowed.to).toBe(3);
  });
});

describe('projection binding — two peers typing in the same block', () => {
  const SHARED = [
    'Filler block 0 untouched.',
    'Filler block 1 untouched.',
    'Target block for co-editing.',
    'Filler block 3 untouched.',
  ].join('\n\n');

  function syncBoth(left: Rig, right: Rig): void {
    Y.applyUpdate(right.ydoc, Y.encodeStateAsUpdate(left.ydoc, Y.encodeStateVector(right.ydoc)));
    Y.applyUpdate(left.ydoc, Y.encodeStateAsUpdate(right.ydoc, Y.encodeStateVector(left.ydoc)));
  }

  function createPeers(): [Rig, Rig] {
    const first = createRig(`${SHARED}\n`);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(first.ydoc));
    return [first, createRigOn(replica)];
  }

  function copiesOfTarget(text: string): number {
    return text.split('Target block for co-editing.').length - 1;
  }

  it('keeps one copy of the block when both edits land concurrently', () => {
    const [a, b] = createPeers();
    try {
      appendToBlock(a.editor, 2, 'A');
      appendToBlock(b.editor, 2, 'B');
      syncBoth(a, b);

      expect(a.ytext.toString()).toBe(b.ytext.toString());
      expect(copiesOfTarget(a.ytext.toString())).toBe(1);
      expect(a.ytext.toString().split('untouched.').length - 1).toBe(3);
      expect(a.ytext.toString().match(/A/g)?.length ?? 0).toBe(1);
      expect(a.ytext.toString().match(/B/g)?.length ?? 0).toBe(1);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('carries the caret past a remote insert that lands at it, not into the block text', () => {
    const [a, b] = createPeers();
    try {
      const doc = a.editor.state.doc;
      let pos = 0;
      for (let i = 0; i <= 2; i++) pos += doc.child(i).nodeSize;
      a.editor.view.dispatch(a.editor.state.tr.setSelection(TextSelection.create(doc, pos - 1)));

      appendToBlock(b.editor, 2, 'B');
      syncBoth(a, b);

      a.editor.view.dispatch(a.editor.state.tr.insertText('A'));
      syncBoth(a, b);

      expect(a.ytext.toString()).toContain('Target block for co-editing.');
      expect(a.ytext.toString()).toContain('Target block for co-editing.BA');
      expect(copiesOfTarget(a.ytext.toString())).toBe(1);
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it('keeps one copy of the block across a divergence window of many keystrokes', () => {
    const [a, b] = createPeers();
    try {
      for (let i = 0; i < 10; i++) {
        appendToBlock(a.editor, 2, 'A');
        appendToBlock(b.editor, 2, 'B');
      }
      syncBoth(a, b);

      const converged = a.ytext.toString();
      expect(b.ytext.toString()).toBe(converged);
      expect(copiesOfTarget(converged)).toBe(1);
      expect(converged.match(/A/g)?.length ?? 0).toBe(10);
      expect(converged.match(/B/g)?.length ?? 0).toBe(10);
      expect(converged.split('untouched.').length - 1).toBe(3);
    } finally {
      a.destroy();
      b.destroy();
    }
  });
});

describe('the extension list services the projection, never a fragment binding', () => {
  function makeProvider() {
    const ydoc = new Y.Doc();
    ydoc.transact(() => ydoc.getText('source').insert(0, DOC), 'seed');
    const awareness = new Awareness(ydoc);
    const provider = {
      document: ydoc,
      configuration: { name: 'flag-arms' },
      awareness,
    } as unknown as HocuspocusProvider;
    return {
      provider,
      ydoc,
      cleanup: () => {
        awareness.destroy();
        ydoc.destroy();
      },
    };
  }

  it('binds the projection, and none of the extensions the fragment needed', () => {
    const { provider, ydoc, cleanup } = makeProvider();
    const projection = createProjectionBinding({ ytext: ydoc.getText('source'), md });
    const names = buildExtensionList({
      provider,
      clipboard: fakeClipboard,
      ctorStart: 0,
      projection,
    }).map((extension) => extension.name);
    expect(names).toContain('okProjectionBinding');
    expect(names).not.toContain('collaboration');
    expect(names).not.toContain('bindingStalenessGuard');
    expect(names).not.toContain('walkCurrency');
    cleanup();
  });

  it('carries a collaborationCursor that renders remote carets off the projection, not ySync', () => {
    const { provider, ydoc, cleanup } = makeProvider();
    const projection = createProjectionBinding({ ytext: ydoc.getText('source'), md });
    const names = buildExtensionList({
      provider,
      clipboard: fakeClipboard,
      ctorStart: 0,
      projection,
    }).map((extension) => extension.name);
    expect(names).toContain('collaborationCursor');
    cleanup();
  });
});

describe('the Pattern D constructor path builds from the projection', () => {
  function makeCtorProvider() {
    const ydoc = new Y.Doc();
    ydoc.transact(() => ydoc.getText('source').insert(0, DOC), 'seed');
    const awareness = new Awareness(ydoc);
    const provider = {
      document: ydoc,
      configuration: { name: 'ctor-arms' },
      awareness,
    } as unknown as HocuspocusProvider;
    return {
      provider,
      cleanup: () => {
        awareness.destroy();
        ydoc.destroy();
      },
    };
  }

  const clipboardWithMd = { ...fakeClipboard, mdManager: md } as typeof fakeClipboard;

  it('injects the projection as the editor content, with no fragment walk', () => {
    const { provider, cleanup } = makeCtorProvider();
    const options = buildPatternDConstructorOptions({
      provider,
      clipboard: clipboardWithMd,
      ctorStart: 0,
    });
    expect(options.element).toBeNull();

    const editor = { options: { content: undefined as unknown }, schema: undefined };
    options.onBeforeCreate?.({ editor } as never);
    const content = editor.options.content as { type: string; content: unknown[] };
    expect(content.type).toBe('doc');
    expect(content.content).toHaveLength(4);
    cleanup();
  });
});

describe('projection binding — a held block the source cannot spell', () => {
  const LIST_TAIL = '# Heading\n\nIntro.\n\n- one\n- two\n';

  function expectAligned(rig: Rig): void {
    const projection = rig.stats.projection as unknown as {
      map: { blocks: readonly unknown[] };
    };
    expect(projection.map.blocks.length).toBe(rig.editor.state.doc.childCount);
  }

  function enterAtEnd(rig: Rig): void {
    rig.editor.commands.focus('end');
    rig.editor.commands.insertContent('\n');
  }

  it('keeps the held block in the table across a rebuild', () => {
    const rig = createRig(LIST_TAIL);
    enterAtEnd(rig);
    const held = rig.editor.state.doc.childCount;
    expectAligned(rig);

    rig.ydoc.transact(() => rig.ytext.insert(0, '<!-- x -->\n\n'), 'remote');

    expect(rig.editor.state.doc.childCount).toBeGreaterThanOrEqual(held);
    expectAligned(rig);
    rig.destroy();
  });

  it('materializes the held block into bytes when typed into', () => {
    const rig = createRig(LIST_TAIL);
    enterAtEnd(rig);
    rig.ydoc.transact(() => rig.ytext.insert(0, '<!-- x -->\n\n'), 'remote');

    const last = rig.editor.state.doc.childCount - 1;
    appendToBlock(rig.editor, last, 'X');

    expect(rig.ytext.toString()).not.toContain('twoX');
    expect(rig.ytext.toString()).toContain('X');
    expectAligned(rig);
    rig.destroy();
  });

  it('does not re-parse on a keystroke after a rebuild', () => {
    const rig = createRig(LIST_TAIL);
    enterAtEnd(rig);
    rig.ydoc.transact(() => rig.ytext.insert(0, '<!-- x -->\n\n'), 'remote');

    appendToBlock(rig.editor, 1, 'a');
    const before = rig.stats.rebuilds;
    for (const ch of 'bcdefghij') appendToBlock(rig.editor, 1, ch);
    expect(rig.stats.rebuilds).toBe(before);
    rig.destroy();
  });

  it('survives Enter out of a list and types into the new paragraph', () => {
    const rig = createRig(LIST_TAIL);
    const editor = rig.editor;
    editor.commands.focus('end');
    editor.commands.splitListItem('listItem');
    editor.commands.liftListItem('listItem');
    expectAligned(rig);

    const beforeText = rig.ytext.toString();
    editor.commands.insertContent('after');
    expect(rig.ytext.toString()).not.toBe(beforeText);
    expect(rig.ytext.toString()).toContain('after');
    expect(rig.ytext.toString()).not.toContain('twoafter');
    expectAligned(rig);
    rig.destroy();
  });
});

describe('projection binding — editing inside a JSX component', () => {
  const WITH_CALLOUT = [
    '# Title',
    '',
    '<Callout type="info">',
    'Original callout text.',
    '</Callout>',
    '',
    'Trailing paragraph.',
    '',
  ].join('\n');

  function appendInside(editor: Editor, contains: string, text: string): void {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes(contains)) at = pos + (node.text?.length ?? 0);
    });
    expect(at).toBeGreaterThanOrEqual(0);
    editor.view.dispatch(editor.state.tr.insertText(text, at, at));
  }

  it('projects the component as a single top-level block', () => {
    const rig = createRig(WITH_CALLOUT);
    expect(rig.editor.state.doc.child(1).type.name).toBe('jsxComponent');
    rig.destroy();
  });

  it('carries an edit inside the component into Y.Text', () => {
    const rig = createRig(WITH_CALLOUT);
    appendInside(rig.editor, 'Original callout text', ' EDITED');
    expect(rig.ytext.toString()).toContain('EDITED');
    rig.destroy();
  });

  it('leaves blocks outside the component untouched', () => {
    const rig = createRig(WITH_CALLOUT);
    appendInside(rig.editor, 'Original callout text', ' EDITED');
    expect(rig.ytext.toString()).toContain('# Title');
    expect(rig.ytext.toString()).toContain('Trailing paragraph.');
    rig.destroy();
  });
});

describe('projection binding — a rebuild that changes no bytes', () => {
  const WITH_LINK = '# Heading\n\nSee [docs](target.md) here.\n\nTail.\n';

  function rebuildBlockSameBytes(editor: Editor, blockIndex: number): void {
    const { doc, schema, tr } = editor.state;
    let pos = 0;
    for (let i = 0; i < blockIndex; i++) pos += doc.child(i).nodeSize;
    const node = doc.child(blockIndex);
    const marked = node.content.content.map((child) =>
      child.isText && child.text !== undefined && child.text.length > 0
        ? child.mark([...child.marks, schema.marks.sourceLiteral.create({ sourceRaw: child.text })])
        : child,
    );
    editor.view.dispatch(
      tr.replaceWith(pos, pos + node.nodeSize, node.type.create(node.attrs, marked)),
    );
  }

  it('does not touch Y.Text when the block serializes identically', () => {
    const rig = createRig(WITH_LINK);
    const before = rig.ytext.toString();
    const origins: unknown[] = [];
    rig.ytext.observe((_event, transaction) => origins.push(transaction.origin));

    rebuildBlockSameBytes(rig.editor, 1);

    expect(rig.ytext.toString()).toBe(before);
    expect(origins).toEqual([]);
    rig.destroy();
  });

  it('leaves the redo stack intact, so redo still works', () => {
    const rig = createRig(WITH_LINK);
    const undoManager = sharedUndoManagerFor(rig.ytext);
    appendToBlock(rig.editor, 2, '!');
    undoManager.stopCapturing();
    undoManager.undo();
    expect(undoManager.redoStack).toHaveLength(1);

    rebuildBlockSameBytes(rig.editor, 1);

    expect(undoManager.redoStack).toHaveLength(1);
    undoManager.redo();
    expect(rig.ytext.toString()).toContain('Tail.!');
    rig.destroy();
  });
});

describe('projection binding — a document the MDX parser rejects', () => {
  const BROKEN = 'Above.\n\n</Callout>\n\nBelow.\n';

  it('mounts instead of throwing, showing the body as one raw block', () => {
    const rig = createRig(BROKEN);
    expect(rig.editor.state.doc.childCount).toBe(1);
    expect(rig.editor.state.doc.child(0).type.name).toBe('rawMdxFallback');
    expect(rig.ytext.toString()).toBe(BROKEN);
    rig.destroy();
  });

  it('still applies an external write, so the document does not wedge', () => {
    const rig = createRig(BROKEN);
    rig.ydoc.transact(() => {
      rig.ytext.insert(rig.ytext.length, 'Appended while broken.\n');
    }, 'agent');
    expect(rig.editor.state.doc.child(0).textContent).toContain('Appended while broken.');
    rig.destroy();
  });

  it('recovers the real document when the source is repaired', () => {
    const rig = createRig(BROKEN);
    rig.ydoc.transact(() => {
      rig.ytext.delete(0, rig.ytext.length);
      rig.ytext.insert(0, 'Above.\n\nBelow.\n');
    }, 'repair');
    expect(rig.editor.state.doc.childCount).toBe(2);
    expect(rig.editor.state.doc.child(0).type.name).toBe('paragraph');
    expect(rig.editor.state.doc.child(0).textContent).toBe('Above.');
    rig.destroy();
  });

  it('does not rewrite the rejected bytes when an edit lands elsewhere', () => {
    const rig = createRig(BROKEN);
    rig.ydoc.transact(() => rig.ytext.insert(0, 'Preamble.\n\n'), 'agent');
    expect(rig.ytext.toString()).toBe(`Preamble.\n\n${BROKEN}`);
    rig.destroy();
  });
});

describe('projection binding — a silent drop is named on the wire', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function emittedEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
    return spy.mock.calls.flatMap(([first]) => {
      if (typeof first !== 'string') return [];
      try {
        const parsed = JSON.parse(first) as Record<string, unknown>;
        return typeof parsed.event === 'string' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  const names = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    emittedEvents(spy).map((e) => e.event as string);

  function blockStart(editor: Editor, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
    return pos;
  }

  function typeInto(editor: Editor, blockIndex: number, ch: string): void {
    const at = endOfBlock(editor, blockIndex);
    editor.view.dispatch(editor.state.tr.insertText(ch, at, at));
  }

  function deleteBlockText(rig: Rig, blockIndex: number): void {
    const from = blockStart(rig.editor, blockIndex) + 1;
    rig.editor.view.dispatch(
      rig.editor.state.tr.setSelection(
        TextSelection.create(rig.editor.state.doc, from, endOfBlock(rig.editor, blockIndex)),
      ),
    );
    rig.editor.commands.deleteSelection();
  }

  it('says nothing at all while ordinary typing lands', () => {
    const rig = createRig(DOC);
    for (const ch of 'abcdef') typeInto(rig.editor, 1, ch);
    expect(rig.ytext.toString()).toContain('inside.abcdef');
    expect(names(warn)).toEqual([]);
    expect(names(info)).toEqual([]);
    rig.destroy();
  });

  it('names the rebase it declined for a write that is only newlines', () => {
    const rig = createRig('a\n\nb\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));

    expect(rig.ytext.toString()).toBe('a\n\n\nb\n');
    expect(names(warn)).toEqual([]);
    expect(emittedEvents(info)).toEqual([
      {
        event: 'ok-projection-rebase-declined',
        reason: 'all-newline-write',
        textLength: 3,
        declines: 1,
      },
    ]);
    rig.destroy();
  });

  it('names every step of the walk from a lossy re-parse to the re-derive that ends it', () => {
    const rig = createRig('- one\n\nmid\n\n- two\n');
    expect(rig.editor.state.doc.childCount).toBe(3);

    deleteBlockText(rig, 1);

    expect(emittedEvents(info)).toEqual([
      {
        event: 'ok-projection-rebase-declined',
        reason: 'all-newline-write',
        textLength: 3,
        declines: 1,
      },
      {
        event: 'ok-projection-reproject-mismatch',
        rebuiltChildren: 1,
        children: 3,
        mismatches: 1,
      },
      {
        event: 'ok-projection-align-declined',
        site: 'reproject-fallback',
        reason: 'unaccounted-doc-block',
        index: 2,
        blocks: 1,
        children: 3,
        declines: 1,
      },
    ]);
    expect(emittedEvents(warn)).toEqual([
      {
        event: 'ok-projection-doc-rederived',
        site: 'reproject-fallback',
        blocks: 1,
        children: 3,
        rederives: 1,
      },
    ]);
    expect(rig.stats.spliceDeclines).toBe(0);
    rig.destroy();
  });

  it('leaves the block table agreeing with the document the source re-parses into', () => {
    const rig = createRig('- one\n\nmid\n\n- two\n');

    deleteBlockText(rig, 1);

    expect(rig.ytext.toString()).toBe('- one\n\n\n- two\n');
    expect(rig.editor.state.doc.childCount).toBe(1);
    expect(rig.stats.projection.map.blocks).toHaveLength(1);
    expect(rig.stats.docRederives).toBe(1);
    rig.destroy();
  });

  it('keeps the next keystroke instead of discarding it against a stale table', () => {
    const rig = createRig('- one\n\nmid\n\n- two\n');
    deleteBlockText(rig, 1);
    warn.mockClear();
    info.mockClear();

    typeInto(rig.editor, rig.editor.state.doc.childCount - 1, 'Z');

    expect(rig.ytext.toString()).toContain('Z');
    expect(names(warn)).toEqual([]);
    expect(rig.stats.spliceDeclines).toBe(0);
    rig.destroy();
  });

  it('keeps the second list when the keystroke after the re-parse lands in block 0', () => {
    const rig = createRig('- one\n\n  X\n\nmid\n\n- two\n\n  Y\n');
    deleteBlockText(rig, 1);

    typeInto(rig.editor, 0, 'Q');

    const source = rig.ytext.toString();
    expect(source).toContain('two');
    expect(source).toContain('Y');
    expect(source).toContain('Q');
    rig.destroy();
  });

  it('warns when a splice cannot reach a Y.Text that has lost its document', () => {
    const rig = createRig('a\n');
    (rig.ytext as unknown as { doc: unknown }).doc = null;

    typeInto(rig.editor, 0, 'X');

    expect(emittedEvents(warn)).toEqual([
      {
        event: 'ok-projection-write-dropped',
        spliceFrom: 0,
        spliceTo: 1,
        textLength: 2,
        children: 1,
        dropped: 1,
      },
    ]);
    expect(rig.stats.writes).toBe(0);
    rig.editor.destroy();
  });

  it('counts a doc rebuilt into identical blocks without emitting anything', () => {
    const rig = createRig('# H\n\nalpha\n');
    const at = blockStart(rig.editor, 1);
    const node = rig.editor.state.doc.child(1);
    rig.editor.view.dispatch(
      rig.editor.state.tr.replaceWith(
        at,
        at + node.nodeSize,
        node.type.create(node.attrs, node.content, node.marks),
      ),
    );

    expect(rig.stats.unchangedUpdates).toBe(1);
    expect(names(warn)).toEqual([]);
    expect(names(info)).toEqual([]);
    rig.destroy();
  });
});
