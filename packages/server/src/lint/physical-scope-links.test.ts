import { describe, expect, test } from 'vitest';
import { BacklinkIndex } from '../backlink-index.ts';

describe('isolated backlink document inventory', () => {
  test('resolves a single source against an immutable inventory without registering extra graph sources', () => {
    const inventory = new Set(['guides/known', 'literal.md']);
    const index = new BacklinkIndex({
      projectDir: '/unused',
      contentDir: '/unused',
      documentNames: inventory,
    });
    inventory.add('late');
    index.updateDocumentFromMarkdown('source', '[[known]] [[literal.md]] [[late]] [[missing]]');
    expect(index.getIndexedDocNames()).toEqual(['source']);
    expect(
      index
        .getDeadLinks(['source'])
        .map((entry) => entry.target)
        .sort(),
    ).toEqual(['late', 'missing']);
  });

  test('ordinary graph callers retain their own live inventory and source edits', () => {
    const index = new BacklinkIndex({ projectDir: '/unused', contentDir: '/unused' });
    index.updateDocumentFromMarkdown('source', '[[known]]');
    expect(index.getDeadLinks(['source']).map((entry) => entry.target)).toEqual(['known']);
    index.updateDocumentFromMarkdown('guides/known', '# Known');
    expect(index.getDeadLinks(['source', 'guides/known'])).toEqual([]);
    index.updateDocumentFromMarkdown('source', '[[new-ghost]]');
    expect(index.getDeadLinks(['source', 'guides/known']).map((entry) => entry.target)).toEqual([
      'new-ghost',
    ]);
  });
});
