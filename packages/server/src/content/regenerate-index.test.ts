import { describe, expect, test } from 'vitest';
import {
  collectIndexDirectories,
  type DirectoryIndexDeps,
  directoryChainToRoot,
  type IndexSourceDoc,
  indexedFieldsChanged,
  indexedMetadataChanged,
  isGeneratedIndexDocName,
  planDirectoryIndexRegenerations,
} from './regenerate-index.ts';

function sorted(directories: Set<string>): string[] {
  return [...directories].sort();
}

describe('collectIndexDirectories', () => {
  test('every ancestor of a document is included, even containers with no direct markdown', () => {
    expect(sorted(collectIndexDirectories(['guide/deep/note']))).toEqual([
      '',
      'guide',
      'guide/deep',
    ]);
  });

  test('a directory with no admitted markdown at any depth is excluded', () => {
    const directories = collectIndexDirectories(['docs/guide', 'archive/index']);
    expect(sorted(directories)).toEqual(['', 'docs']);
    expect(directories.has('archive')).toBe(false);
  });

  test('reserved-stem documents do not earn their directory an index; a real sibling does', () => {
    expect(sorted(collectIndexDirectories(['wiki/index', 'wiki/log']))).toEqual(['']);
    expect(sorted(collectIndexDirectories(['wiki/index', 'wiki/real']))).toEqual(['', 'wiki']);
  });

  test('infrastructure under dot-directories contributes no directories', () => {
    const directories = collectIndexDirectories([
      '.ok/templates/note',
      'concepts/.ok/templates/card',
      'real/doc',
    ]);
    expect(sorted(directories)).toEqual(['', 'real']);
  });

  test('the root is always present — an empty bundle or one holding only reserved files', () => {
    expect(sorted(collectIndexDirectories([]))).toEqual(['']);
    expect(sorted(collectIndexDirectories(['index', 'log']))).toEqual(['']);
  });

  test('the same documents in any order derive the same set', () => {
    const forward = collectIndexDirectories(['a/one', 'a/b/two', 'c/three']);
    const reverse = collectIndexDirectories(['c/three', 'a/b/two', 'a/one']);
    expect(sorted(forward)).toEqual(sorted(reverse));
    expect(sorted(forward)).toEqual(['', 'a', 'a/b', 'c']);
  });
});

describe('planDirectoryIndexRegenerations', () => {
  function directoryDeps(
    docs: Record<string, IndexSourceDoc>,
    currentMarkdownFor: (directory: string) => string | null = () => null,
  ): DirectoryIndexDeps {
    return { docs: Object.entries(docs), docExtension: () => '.md', currentMarkdownFor };
  }

  const TREE: Record<string, IndexSourceDoc> = {
    welcome: { title: 'Welcome', type: 'note' },
    'concepts/aggregate': { title: 'Aggregate', type: 'concept' },
    'concepts/nested/deep': { title: 'Deep', type: 'concept' },
  };

  test('produces one decision per directory, deepest-first, each scoped to its own directory', () => {
    const decisions = planDirectoryIndexRegenerations(directoryDeps(TREE));

    expect(decisions).toEqual([
      {
        directory: 'concepts/nested',
        changed: true,
        markdown: '# Index\n\n## concept\n\n* [Deep](./deep.md)\n',
      },
      {
        directory: 'concepts',
        changed: true,
        markdown:
          '# Index\n\n## concept\n\n* [Aggregate](./aggregate.md)\n\n## Subdirectories\n\n* [nested](./nested/index.md)\n',
      },
      {
        directory: '',
        changed: true,
        markdown:
          '---\nokf_version: "0.2"\n---\n\n# Index\n\n## note\n\n* [Welcome](./welcome.md)\n\n## Subdirectories\n\n* [concepts](./concepts/index.md)\n',
      },
    ]);
  });

  test('feeding each directory its own bytes back settles the whole set with no churn', () => {
    const first = planDirectoryIndexRegenerations(directoryDeps(TREE));
    const settled = new Map(first.map((d) => [d.directory, d.markdown]));

    const second = planDirectoryIndexRegenerations(
      directoryDeps(TREE, (directory) => settled.get(directory) ?? null),
    );

    expect(second.some((d) => d.changed)).toBe(false);
    expect(second.map((d) => d.markdown)).toEqual(first.map((d) => d.markdown));
  });

  test('each decision compares against its own directory, not the root', () => {
    const rootBytes = planDirectoryIndexRegenerations(directoryDeps(TREE)).find(
      (d) => d.directory === '',
    )?.markdown;

    const changed = new Map(
      planDirectoryIndexRegenerations(directoryDeps(TREE, () => rootBytes ?? null)).map((d) => [
        d.directory,
        d.changed,
      ]),
    );

    expect(changed.get('')).toBe(false);
    expect(changed.get('concepts')).toBe(true);
    expect(changed.get('concepts/nested')).toBe(true);
  });

  test('a directory whose bytes already match is unchanged while a differing sibling rebuilds', () => {
    const conceptsBytes =
      planDirectoryIndexRegenerations(directoryDeps(TREE)).find((d) => d.directory === 'concepts')
        ?.markdown ?? null;

    const changed = new Map(
      planDirectoryIndexRegenerations(
        directoryDeps(TREE, (directory) => (directory === 'concepts' ? conceptsBytes : null)),
      ).map((d) => [d.directory, d.changed]),
    );

    expect(changed.get('concepts')).toBe(false);
    expect(changed.get('')).toBe(true);
    expect(changed.get('concepts/nested')).toBe(true);
  });

  test('a container directory with markdown only below it lists subdirectories and no type section', () => {
    const guide = planDirectoryIndexRegenerations(
      directoryDeps({ 'guide/ddd/note': { title: 'Note', type: 'concept' } }),
    ).find((d) => d.directory === 'guide');

    expect(guide?.markdown).toBe('# Index\n\n## Subdirectories\n\n* [ddd](./ddd/index.md)\n');
  });

  test('the same documents in any input order produce identical decisions', () => {
    const docs: Record<string, IndexSourceDoc> = {
      'alpha/one': { title: 'One', type: 'note' },
      'beta/two': { title: 'Two', type: 'note' },
    };
    const forward = planDirectoryIndexRegenerations(directoryDeps(docs));
    const reversed = planDirectoryIndexRegenerations(
      directoryDeps(Object.fromEntries(Object.entries(docs).reverse())),
    );

    expect(reversed).toEqual(forward);
    expect(forward.map((d) => d.directory)).toEqual(['alpha', 'beta', '']);
  });

  test('planning is complete even when docs is a single-use iterator', () => {
    function* once(): Generator<readonly [string, IndexSourceDoc]> {
      yield ['welcome', { title: 'Welcome', type: 'note' }];
      yield ['concepts/aggregate', { title: 'Aggregate', type: 'concept' }];
    }

    const decisions = planDirectoryIndexRegenerations({
      docs: once(),
      docExtension: () => '.md',
      currentMarkdownFor: () => null,
    });

    expect(decisions.map((d) => d.directory).sort()).toEqual(['', 'concepts']);
    expect(decisions.find((d) => d.directory === 'concepts')?.markdown).toContain(
      '* [Aggregate](./aggregate.md)',
    );
    expect(decisions.find((d) => d.directory === '')?.markdown).toContain(
      '* [Welcome](./welcome.md)',
    );
  });
});

describe('indexedFieldsChanged', () => {
  const BODY = '\n# Heading\n\nSome prose.\n';
  const doc = (fm: string, body = BODY) => `---\n${fm}\n---\n${body}`;

  test('a title change schedules a rebuild', () => {
    const before = doc('title: Old\ntype: note');
    const after = doc('title: New\ntype: note');
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(true);
  });

  test('a description change schedules a rebuild', () => {
    const before = doc('title: A\ndescription: Before\ntype: note');
    const after = doc('title: A\ndescription: After\ntype: note');
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(true);
  });

  test('a type change schedules a rebuild — it moves the entry between sections', () => {
    const before = doc('title: A\ntype: note');
    const after = doc('title: A\ntype: concept');
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(true);
  });

  test('editing only the body does NOT schedule a rebuild', () => {
    const fm = 'title: A\ndescription: D\ntype: note';
    const before = doc(fm, '\n# Heading\n\nSome prose.\n');
    const after = doc(
      fm,
      '\n# Heading\n\nSome prose, considerably extended.\n\nAnd a new paragraph.\n',
    );
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(false);
  });

  test('adding a heading below the first does NOT schedule a rebuild', () => {
    const fm = 'title: A\ntype: note';
    const before = doc(fm, '\n# Heading\n\nProse.\n');
    const after = doc(fm, '\n# Heading\n\nProse.\n\n## A later section\n\nMore.\n');
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(false);
  });

  test('a frontmatter key the index never renders does NOT schedule a rebuild', () => {
    const before = doc('title: A\ntype: note\ntags: [x]');
    const after = doc('title: A\ntype: note\ntags: [x, y, z]');
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(false);
  });

  test('an identical write does NOT schedule a rebuild', () => {
    const same = doc('title: A\ndescription: D\ntype: note');
    expect(indexedFieldsChanged(same, same, 'notes/a')).toBe(false);
  });

  test('a first write schedules a rebuild with no special case for absent previous bytes', () => {
    const after = doc('title: A\ntype: note');
    expect(indexedFieldsChanged(null, after, 'notes/a')).toBe(true);
    expect(indexedFieldsChanged(undefined, after, 'notes/a')).toBe(true);
  });

  test('a title arriving via the first-heading fallback schedules a rebuild', () => {
    const before = '# Old heading\n\nProse.\n';
    const after = '# New heading\n\nProse.\n';
    expect(indexedFieldsChanged(before, after, 'notes/a')).toBe(true);
  });
});

describe('indexedMetadataChanged', () => {
  const BODY = '\n# Heading\n\nSome prose.\n';
  const doc = (fm: string, body = BODY) => `---\n${fm}\n---\n${body}`;

  test('absent cached fields schedule a rebuild', () => {
    expect(indexedMetadataChanged(undefined, doc('title: A\ntype: note'), 'notes/a')).toBe(true);
  });

  test('cached fields matching the new bytes do NOT schedule a rebuild', () => {
    const previous = { title: 'A', description: 'D', type: 'note' };
    const after = doc('title: A\ndescription: D\ntype: note', '\n# A\n\nRewritten prose.\n');
    expect(indexedMetadataChanged(previous, after, 'notes/a')).toBe(false);
  });

  test('a title change schedules a rebuild', () => {
    const previous = { title: 'Old', type: 'note' };
    expect(indexedMetadataChanged(previous, doc('title: New\ntype: note'), 'notes/a')).toBe(true);
  });

  test('a description change schedules a rebuild', () => {
    const previous = { title: 'A', description: 'Before', type: 'note' };
    const after = doc('title: A\ndescription: After\ntype: note');
    expect(indexedMetadataChanged(previous, after, 'notes/a')).toBe(true);
  });

  test('a type change schedules a rebuild — it moves the entry between sections', () => {
    const previous = { title: 'A', type: 'note' };
    expect(indexedMetadataChanged(previous, doc('title: A\ntype: concept'), 'notes/a')).toBe(true);
  });

  test('an unenriched cached entry with a titled document schedules a rebuild', () => {
    const previous = { title: undefined, description: undefined, type: undefined };
    expect(indexedMetadataChanged(previous, doc('title: A\ntype: note'), 'notes/a')).toBe(true);
  });
});

describe('directoryChainToRoot', () => {
  test('a nested directory yields itself then each ancestor, ending at root', () => {
    expect(directoryChainToRoot('a/b/c')).toEqual(['a/b/c', 'a/b', 'a', '']);
  });

  test('a top-level directory yields itself then root', () => {
    expect(directoryChainToRoot('a')).toEqual(['a', '']);
  });

  test('the root yields only itself', () => {
    expect(directoryChainToRoot('')).toEqual(['']);
  });
});

describe('isGeneratedIndexDocName', () => {
  test('the root index is a generated index', () => {
    expect(isGeneratedIndexDocName('index')).toBe(true);
  });

  test('a child index one level down is a generated index', () => {
    expect(isGeneratedIndexDocName('concepts/index')).toBe(true);
  });

  test('a deeply nested index is a generated index', () => {
    expect(isGeneratedIndexDocName('a/b/c/index')).toBe(true);
  });

  test('an ordinary document is not a generated index', () => {
    expect(isGeneratedIndexDocName('concepts/bounded-context')).toBe(false);
  });

  test('the reserved log stem is not a generated index', () => {
    expect(isGeneratedIndexDocName('log')).toBe(false);
    expect(isGeneratedIndexDocName('concepts/log')).toBe(false);
  });

  test('a document whose name merely begins with index is not a generated index', () => {
    expect(isGeneratedIndexDocName('index-of-terms')).toBe(false);
    expect(isGeneratedIndexDocName('concepts/indexing')).toBe(false);
  });
});
