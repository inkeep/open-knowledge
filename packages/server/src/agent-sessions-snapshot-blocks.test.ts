/**
 * `snapshotBlocks` reads `Y.Text`, not the `Y.XmlFragment`.
 *
 * The block ordinals stamped into an `agent-flash` entry are consumed by a
 * client that indexes its own ProseMirror document by them, and that document
 * is derived from `Y.Text` — so a snapshot taken from the fragment would be
 * answering about a structure nobody is looking at.
 *
 * The fragment is deliberately populated with DIFFERENT content in the
 * divergence row below. That is not a realistic document state; it is the only
 * way to prove which of the two replicas the function actually consulted, and
 * it is what would silently fail if someone re-pointed it at the fragment for
 * being the cheaper read.
 */

import type { Document } from '@hocuspocus/server';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { snapshotBlocks } from './agent-sessions.ts';

const md = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

/** A doc holding `source` in `Y.Text`, and optionally other markdown in the fragment. */
function docWith(source: string, fragmentMd?: string): Document {
  const doc = new Y.Doc() as unknown as Document;
  doc.getText('source').insert(0, source);
  if (fragmentMd !== undefined) {
    const fragment = doc.getXmlFragment('default');
    const pmDoc = schema.nodeFromJSON(md.parseWithFallback(fragmentMd));
    doc.transact(() =>
      updateYFragment(doc as unknown as Y.Doc, fragment, pmDoc, {
        mapping: new Map(),
        isOMark: new Map(),
      }),
    );
  }
  return doc;
}

describe('snapshotBlocks', () => {
  test('returns one entry per top-level block of the markdown', () => {
    const blocks = snapshotBlocks(docWith('# Title\n\nFirst.\n\nSecond.\n'));
    expect(blocks).toEqual(['# Title', 'First.', 'Second.']);
  });

  test('follows Y.Text when the fragment holds something else', () => {
    // Y.Text says two blocks; the fragment says four. Reading the fragment
    // would return four entries and misplace every ordinal after the first.
    const doc = docWith(
      '# Real\n\nThe authoritative body.\n',
      '# Stale\n\nOne.\n\nTwo.\n\nThree.\n',
    );
    expect(doc.getXmlFragment('default').toArray()).toHaveLength(4);
    expect(snapshotBlocks(doc)).toEqual(['# Real', 'The authoritative body.']);
  });

  test('is empty for an empty document', () => {
    expect(snapshotBlocks(docWith(''))).toEqual([]);
  });

  test('skips the frontmatter fence — ordinals address body blocks', () => {
    // The fence is not a top-level block in the editor's view of the document,
    // so counting it would shift every ordinal by one on every doc with FM.
    const blocks = snapshotBlocks(docWith('---\ntitle: T\n---\n\n# Heading\n\nBody.\n'));
    expect(blocks).toEqual(['# Heading', 'Body.']);
  });
});
