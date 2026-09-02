/**
 * The single-CRDT client binding, end to end over a real `Y.Doc` and a real
 * ProseMirror view.
 *
 * What is being pinned here is not "typing works" — it is the four properties
 * that make the migration worth doing, each of which the two-replica bridge
 * either cannot provide or provides only behind a guard:
 *
 *  1. A WYSIWYG edit reaches `Y.Text` under the USER's origin. That is what
 *     lets one `Y.UndoManager` see it (Phase 2), and what the server bridge
 *     structurally cannot do, because its rewrite runs under
 *     `OBSERVER_SYNC_ORIGIN` and is tracked by neither undo stack.
 *  2. Bytes outside the edited block never move. Today's bridge line-diffs a
 *     whole re-serialized document, so it rewrites bytes the user never
 *     touched.
 *  3. An external write — an agent, a file watcher, another client — is picked
 *     up without a derive, a latch, or a demand gate. There is no second
 *     replica to go stale, which is the whole stale-WYSIWYG class.
 *  4. Typing does not re-parse the document. A keystroke rebases arithmetically;
 *     only an outside write pays a parse.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor, getSchema } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  createProjectionBinding,
  mapOffsetThroughDelta,
  projectionBindingEnabled,
} from './projection-binding';
import { sharedUndoManagerFor } from './shared-undo-manager';
import { buildExtensionList, buildPatternDConstructorOptions } from './TiptapEditor';
import { fakeClipboard, installDomGlobals } from './walk-currency-test-harness';

const md = new MarkdownManager({ extensions: sharedExtensions });
/**
 * The manager the projection actually runs with in the app. The
 * structural-freshness derive is load-bearing for JSX components, so a rig
 * built on a plain manager would pass while the product silently lost edits.
 */
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
  stats: { rebuilds: number; writes: number };
  destroy(): void;
}

function createRig(source: string): Rig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');

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

/** Type at the end of a top-level block, the way a caret at its end would. */
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
    // The shape a whole-document serialize gets wrong.
    expect(after).toContain('[**Desktop**](x)');
    expect(after).not.toContain('**[Desktop](x)**');
    expect(after).toContain('# Heading edited');
    expect(after.slice(after.indexOf('A paragraph'))).toBe(DOC.slice(DOC.indexOf('A paragraph')));
    rig.destroy();
  });

  it('writes one contiguous delete+insert, never a character-minimal diff', () => {
    // The stale-anchor interleave class: changed lines must land as one fresh
    // contiguous run.
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
    // And the projection still agrees with a fresh parse of what it wrote.
    expect(md.parse(after)).toEqual(rig.editor.state.doc.toJSON());
    rig.destroy();
  });
});

/** Put the caret at a document position and press Enter. */
function pressEnter(editor: Editor, at: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
  editor.commands.splitBlock();
}

/** Remove a whole top-level block, the way Backspace on an empty line does. */
function deleteBlock(editor: Editor, blockIndex: number): void {
  let pos = 0;
  for (let i = 0; i < blockIndex; i++) pos += editor.state.doc.child(i).nodeSize;
  const size = editor.state.doc.child(blockIndex).nodeSize;
  editor.view.dispatch(editor.state.tr.delete(pos, pos + size));
}

/** Document position at the end of a top-level block's content. */
function endOfBlock(editor: Editor, blockIndex: number): number {
  let pos = 0;
  for (let i = 0; i <= blockIndex; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos - 1;
}

describe('projection binding — blocks markdown cannot spell', () => {
  // Enter makes an EMPTY paragraph, and markdown has no way to write one: a
  // blank line is only expressible as a wider gap between two blocks that
  // themselves emit. The projection therefore has to hold a block the CRDT does
  // not, until it gets content. Getting this wrong is not subtle — the first
  // version routed the empty block into the deletion branch, failed to place it,
  // rebuilt the document from the unchanged markdown, and Enter appeared to do
  // nothing at all while Shift+Enter (a hard break INSIDE a paragraph, which
  // markdown can spell) worked fine.
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
    // And the projection agrees with a fresh parse of what it wrote.
    expect(md.parse(rig.ytext.toString())).toEqual(rig.editor.state.doc.toJSON());
    rig.destroy();
  });

  it('splits a paragraph in two when Enter lands mid-block', () => {
    // No space at the split point: splitting mid-phrase leaves the second block
    // with a leading space, which the serializer correctly escapes to keep the
    // byte — right behaviour, but it would make this test about escaping.
    const rig = createRig('# H\n\nhelloworld\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 1) - 'world'.length);

    expect(rig.editor.state.doc.childCount).toBe(3);
    expect(rig.ytext.toString()).toBe('# H\n\nhello\n\nworld\n');
    rig.destroy();
  });

  it('preserves a leading space when a split creates one', () => {
    const rig = createRig('# H\n\nhello world\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 1) - ' world'.length);
    // The space survives as an escape rather than being silently dropped.
    expect(rig.ytext.toString()).toBe('# H\n\nhello\n\n&#x20;world\n');
    // Re-parsing gives the space back — as text plus a `sourceLiteral` mark
    // carrying the escape it was written with, so a later serialize re-emits
    // the same bytes. Structural equality is therefore the wrong assertion
    // here: the editor's document and a parse of what it wrote agree on
    // content but not on provenance markup, and only the content is the
    // user-visible claim.
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
    // Undo goes through the shared Y.UndoManager, which saw no write for the
    // empty block; delete it directly instead, the way Backspace would.
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
    // The blank blocks emit nothing at any count, so this is arithmetic on the
    // newlines BETWEEN their emitting neighbours: N blank paragraphs is a gap of
    // N+2. Serializing the changed block instead — which is what the first
    // version did — yields the empty string however many blanks there are, so
    // the run stayed in the editor and never reached the markdown. The symptom
    // was blank lines that survived a round trip through WYSIWYG but collapsed
    // to one the moment you looked at the source.
    const rig = createRig('a\n\nb\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\nb\n');

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\nb\n');

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\n\nb\n');

    // And the run survives a re-projection — which is what a mode switch does.
    expect(md.parse(rig.ytext.toString()).content).toHaveLength(5);
    rig.destroy();
  });

  it('writes a trailing blank run only from the doc-edge floor up', () => {
    const rig = createRig('a\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    // One trailing empty paragraph is indistinguishable from the type-here
    // affordance the editor renders after the last block, so the parse side
    // refuses to carry it and this side must not write it.
    expect(rig.ytext.toString()).toBe('a\n');
    expect(rig.editor.state.doc.childCount).toBe(2);

    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    expect(rig.ytext.toString()).toBe('a\n\n\n\n');
    rig.destroy();
  });

  it('round-trips a blank run through a re-projection', () => {
    // The user-visible bug: blank lines showed in WYSIWYG, collapsed in source,
    // and came back in WYSIWYG only because the editor instance was cached.
    const rig = createRig('a\n\nb\n');
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    pressEnter(rig.editor, endOfBlock(rig.editor, 0));
    const source = rig.ytext.toString();

    // A fresh projection of those bytes — what the other mode, or another
    // client, or a reload would build — has the same blocks.
    const reprojected = md.parse(source) as { content: unknown[] };
    expect(reprojected.content).toHaveLength(rig.editor.state.doc.childCount);
    expect(source).toBe('a\n\n\n\nb\n');
    rig.destroy();
  });

  it('removes an interior blank line again when it is deleted', () => {
    // Deleting a blank reaches the write path as a deletion of a block that
    // occupies no bytes, which the ordinary deletion branch declines. Without
    // the gap path it wrote nothing at all, so the editor showed one fewer
    // blank line than the markdown held — and the next re-projection handed the
    // deleted line straight back.
    const rig = createRig('a\n\n\n\n\nb\n');
    expect(rig.editor.state.doc.childCount).toBe(5);

    for (const expected of ['a\n\n\n\nb\n', 'a\n\n\nb\n', 'a\n\nb\n']) {
      deleteBlock(rig.editor, 1);
      expect(rig.ytext.toString()).toBe(expected);
      // The markdown and the document agree at every step.
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

    // Down to one trailing blank, which is below `MIN_CARRIED_EDGE_EMPTIES` and
    // so unwritable. Writing NO run is the right answer: leaving the two-blank
    // run in place would keep more blank lines in the markdown than the editor
    // shows, and the next re-projection would give back a line the user just
    // deleted.
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
    // The block is still there and still renders as a line, so it must not be
    // deleted from the markdown — it becomes the blank line it now looks like.
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
    // An agent writes while the editor holds a block the CRDT never saw. The
    // reprojection is from the markdown, so the unwritten block goes — correct,
    // since nothing anywhere recorded it.
    rig.ydoc.transact(() => rig.ytext.insert(0, 'Preamble.\n\n'), 'agent');
    expect(rig.editor.state.doc.child(0).textContent).toBe('Preamble.');
    expect(rig.ytext.toString()).toBe(`Preamble.\n\n${DOC}`);

    // And the editor still writes correctly afterwards.
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
    // The whole point of the block scoping: 20 keystrokes, zero document
    // parses. Today's bridge pays a full parse per source keystroke — measured
    // at 72% of the keystroke cost, 911 ms on a 488 KB document.
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

describe('the flag swaps out every extension that services the fragment binding', () => {
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

  it('binds y-sync, its cursor plugin and its staleness guard by default', () => {
    const { provider, cleanup } = makeProvider();
    const names = buildExtensionList({ provider, clipboard: fakeClipboard, ctorStart: 0 }).map(
      (extension) => extension.name,
    );
    expect(names).toContain('collaboration');
    expect(names).toContain('collaborationCursor');
    expect(names).toContain('bindingStalenessGuard');
    expect(names).not.toContain('okProjectionBinding');
    cleanup();
  });

  it('binds the projection instead, and drops all three with the fragment', () => {
    const { provider, ydoc, cleanup } = makeProvider();
    const projection = createProjectionBinding({ ytext: ydoc.getText('source'), md });
    const names = buildExtensionList({
      provider,
      clipboard: fakeClipboard,
      ctorStart: 0,
      projection,
    }).map((extension) => extension.name);
    expect(names).toContain('okProjectionBinding');
    // Each of these exists to service the fragment binding: y-sync itself, the
    // cursor plugin that resolves positions through it, the guard for its Y→PM
    // apply half, and the pre-warm currency guard.
    expect(names).not.toContain('collaboration');
    expect(names).not.toContain('collaborationCursor');
    expect(names).not.toContain('bindingStalenessGuard');
    expect(names).not.toContain('walkCurrency');
    cleanup();
  });
});

describe('the Pattern D constructor path honours the flag', () => {
  function makeFlagProvider() {
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

  /** A clipboard fake carrying a real manager — the projection path parses with it. */
  const clipboardWithMd = { ...fakeClipboard, mdManager: md } as typeof fakeClipboard;

  afterEach(() => {
    window.__okProjectionBinding = undefined;
  });

  it('is off by default', () => {
    expect(projectionBindingEnabled()).toBe(false);
  });

  it('injects the projection as the editor content, with no fragment walk', () => {
    window.__okProjectionBinding = true;
    expect(projectionBindingEnabled()).toBe(true);
    const { provider, cleanup } = makeFlagProvider();
    const options = buildPatternDConstructorOptions({
      provider,
      clipboard: clipboardWithMd,
      ctorStart: 0,
    });
    // `element: null` stays load-bearing on this arm too — omitting it would
    // auto-mount and turn the deferred `editor.mount()` into a second mount.
    expect(options.element).toBeNull();

    const editor = { options: { content: undefined as unknown }, schema: undefined };
    options.onBeforeCreate?.({ editor } as never);
    const content = editor.options.content as { type: string; content: unknown[] };
    expect(content.type).toBe('doc');
    // The projection of DOC, not the empty XmlFragment this provider carries.
    expect(content.content).toHaveLength(4);
    cleanup();
  });

  it('walks the fragment when the flag is off', () => {
    const { provider, cleanup } = makeFlagProvider();
    const options = buildPatternDConstructorOptions({
      provider,
      clipboard: clipboardWithMd,
      ctorStart: 0,
    });
    const schema = getSchema(sharedExtensions);
    const editor = { options: { content: undefined as unknown }, schema };
    options.onBeforeCreate?.({ editor } as never);
    const content = editor.options.content as { type: string; content?: unknown[] };
    expect(content.type).toBe('doc');
    // The fragment is empty, so the fragment walk yields an empty document —
    // the observable difference between the two arms.
    expect(content.content ?? []).toHaveLength(0);
    cleanup();
  });
});

/**
 * A held empty paragraph must survive a projection REBUILD.
 *
 * An empty paragraph — what Enter produces before anything is typed into it —
 * has no markdown spelling, so the projection holds it with a zero-width span
 * and writes nothing. That much already worked. What did not is what happens
 * next: any rebuild re-parses the source, and a parse of those bytes cannot
 * produce a block the bytes do not spell, so the held entry disappears while
 * the block stays in the document. `map.blocks.length === doc.childCount` is
 * then false for the rest of the session.
 *
 * Rebuilds are ordinary — a remote write, an agent edit, or the
 * `reprojectAgainst` fallback after a multi-block change — so this is reached
 * without doing anything unusual.
 *
 * Both consequences are silent. Edits at the tail become unplaceable and are
 * DISCARDED, and `rebaseProjection` refuses outright once the two disagree, so
 * every keystroke falls back to a whole-document parse — the cost the block
 * scoping exists to avoid.
 *
 * Found by hand, not by this suite, and the shape is the one §7 warns about:
 * the symptom lands one keystroke LATER than the edit that broke the table, so
 * it reads as "typing went to the wrong place" rather than "the list exit was
 * mishandled".
 */
describe('projection binding — a held block the source cannot spell', () => {
  const LIST_TAIL = '# Heading\n\nIntro.\n\n- one\n- two\n';

  /** The table must carry one entry per document block, always. */
  function expectAligned(rig: Rig): void {
    const projection = rig.stats.projection as unknown as {
      map: { blocks: readonly unknown[] };
    };
    expect(projection.map.blocks.length).toBe(rig.editor.state.doc.childCount);
  }

  /** Enter at the very end of the document — the everyday way to hold a block. */
  function enterAtEnd(rig: Rig): void {
    rig.editor.commands.focus('end');
    rig.editor.commands.insertContent('\n');
  }

  it('keeps the held block in the table across a rebuild', () => {
    const rig = createRig(LIST_TAIL);
    enterAtEnd(rig);
    const held = rig.editor.state.doc.childCount;
    expectAligned(rig);

    // Force a rebuild the way a remote write would: a foreign-origin change.
    rig.ydoc.transact(() => rig.ytext.insert(0, '<!-- x -->\n\n'), 'remote');

    // The rebuild re-parses bytes that cannot spell the held block. Before the
    // fix the table came back one entry short and stayed that way.
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

    // The reported bug: with no table entry to anchor it, the splice resolved
    // against the PREVIOUS block's span and the text landed at the end of the
    // list's last item.
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
    // `rebaseProjection` refuses whenever the table and document disagree, so a
    // misaligned table turned every keystroke into a whole-document parse.
    expect(rig.stats.rebuilds).toBe(before);
    rig.destroy();
  });

  it('survives Enter out of a list and types into the new paragraph', () => {
    // The reported sequence: a bullet, Enter for a second bullet, Enter again
    // to leave the list, then type.
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
    // Not swallowed into the list's last item.
    expect(rig.ytext.toString()).not.toContain('twoafter');
    expectAligned(rig);
    rig.destroy();
  });
});

/**
 * A WYSIWYG edit INSIDE a JSX component must reach `Y.Text`.
 *
 * A `jsxComponent` serializes from the `sourceRaw` slice captured at parse
 * time, not from its children. So an edit inside one emits the stale capture
 * and is silently discarded: it stays on screen, never reaches the CRDT, and
 * disappears at the next mode switch or reload. Nothing reports it.
 *
 * Under the bridge this was covered by accident of where the work happened —
 * the SERVER serialized the fragment, and the server's manager has always run
 * with `deriveStructuralFreshness`. Moving the serialize onto the client lost
 * that, because no client manager had the flag. The projection therefore takes
 * its own manager (`getProjectionMarkdownManager`) rather than the clipboard's.
 */
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

  /** Append text to the first text node matching `contains`. */
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
    // The silent-loss shape: without the freshness derive the serialize emits
    // the captured `sourceRaw` verbatim, the splice is byte-identical, and
    // nothing is written at all.
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

/**
 * A block rebuilt WITHOUT its markdown changing must not write.
 *
 * `link`, `wikiLink`, `jsxComponent`, `jsxInline` and `imageReference` are
 * configured per document and carry render-time attrs that are updated after
 * mount. That makes a block unequal to its predecessor while it serializes
 * byte-for-byte the same, so `changedProjectionBlocks` reports a change (the
 * nodes really do differ) and the splice describes a replacement whose text is
 * what is already on disk.
 *
 * Performing that replacement is not a harmless no-op. The transaction is
 * tracked by the shared undo manager, so it CLEARS THE REDO STACK and pushes an
 * undo item that retracts nothing — and it replaces the CRDT items for a range
 * nobody edited, disturbing other clients' cursors and undo attribution.
 *
 * The symptom is remote from the cause and document-shaped: redo stops working
 * after a mode switch, and ONLY on documents containing one of those node
 * types. A document of plain paragraphs cannot reproduce it, which is what made
 * it look intermittent.
 */
describe('projection binding — a rebuild that changes no bytes', () => {
  const WITH_LINK = '# Heading\n\nSee [docs](target.md) here.\n\nTail.\n';

  /**
   * Rebuild a block so it is NOT `eq()` to its predecessor while serializing to
   * exactly the same bytes.
   *
   * The `sourceLiteral` mark carries the raw source a text run came from, so a
   * run marked with its own text emits those same bytes. That is the shape the
   * product reaches through provenance marks and render-time attrs; here it is
   * constructed directly so the test does not depend on which extension
   * happens to refresh a node on mount.
   */
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

    // The bytes are unchanged either way; what must not happen is the WRITE.
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

    // The rebuild a mode switch triggers on a doc holding a link.
    rebuildBlockSameBytes(rig.editor, 1);

    // Before the fix this wrote identical bytes under a tracked origin, and
    // Yjs clears the redo stack on any tracked change that is not an undo/redo.
    expect(undoManager.redoStack).toHaveLength(1);
    undoManager.redo();
    expect(rig.ytext.toString()).toContain('Tail.!');
    rig.destroy();
  });
});
