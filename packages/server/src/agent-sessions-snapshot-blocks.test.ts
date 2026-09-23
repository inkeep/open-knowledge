import type { Document } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { snapshotBlocks } from './agent-sessions.ts';

function docWith(source: string): Document {
  const doc = new Y.Doc() as unknown as Document;
  doc.getText('source').insert(0, source);
  return doc;
}

describe('snapshotBlocks', () => {
  test('returns one entry per top-level block of the markdown', () => {
    const blocks = snapshotBlocks(docWith('# Title\n\nFirst.\n\nSecond.\n'));
    expect(blocks).toEqual(['# Title', 'First.', 'Second.']);
  });

  test('is empty for an empty document', () => {
    expect(snapshotBlocks(docWith(''))).toEqual([]);
  });

  test('skips the frontmatter fence — ordinals address body blocks', () => {
    const blocks = snapshotBlocks(docWith('---\ntitle: T\n---\n\n# Heading\n\nBody.\n'));
    expect(blocks).toEqual(['# Heading', 'Body.']);
  });
});
