import { resolveInternalHref } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { buildIndexMarkdown, GENERATOR_OWNED_HEADINGS, type IndexEntry } from './generate-index.ts';

function entry(overrides: Partial<IndexEntry> & Pick<IndexEntry, 'path' | 'title'>): IndexEntry {
  return { description: undefined, type: undefined, ...overrides };
}

describe('buildIndexMarkdown', () => {
  test('groups entries under a heading per declared type', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'concepts/a.md', title: 'Alpha', type: 'concept' }),
        entry({ path: 'notes/b.md', title: 'Beta', type: 'note' }),
        entry({ path: 'concepts/c.md', title: 'Gamma', type: 'concept' }),
      ],
      { isRoot: false },
    );

    expect(out).toBe(
      [
        '# Index',
        '',
        '## concept',
        '',
        '* [Alpha](./concepts/a.md)',
        '* [Gamma](./concepts/c.md)',
        '',
        '## note',
        '',
        '* [Beta](./notes/b.md)',
        '',
      ].join('\n'),
    );
  });

  test('exactly one top-level heading, whatever the entries', () => {
    for (const entries of [
      [],
      [entry({ path: 'a.md', title: 'A', type: 'note' })],
      [
        entry({ path: 'a.md', title: 'A', type: 'note' }),
        entry({ path: 'b.md', title: 'B', type: 'concept' }),
        entry({ path: 'c.md', title: 'C' }),
      ],
    ]) {
      for (const isRoot of [true, false]) {
        const out = buildIndexMarkdown(entries, { isRoot });
        expect(out.match(/^# .+$/gm), `isRoot=${isRoot}, ${entries.length} entries`).toEqual([
          '# Index',
        ]);
      }
    }
  });

  test('a document with no type lands in Other', () => {
    const out = buildIndexMarkdown([entry({ path: 'scratch.md', title: 'Scratch' })], {
      isRoot: false,
    });
    expect(out).toContain('## Other');
  });

  test('a blank or whitespace-only type is treated as absent, not as its own section', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'a.md', title: 'A', type: '   ' }),
        entry({ path: 'b.md', title: 'B', type: '' }),
      ],
      { isRoot: false },
    );
    expect(out.match(/^## .+$/gm)).toEqual(['## Other']);
  });

  test('sections sort alphabetically and entries sort by title case-insensitively', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'z.md', title: 'zebra', type: 'note' }),
        entry({ path: 'a.md', title: 'Apple', type: 'note' }),
        entry({ path: 'm.md', title: 'mango', type: 'concept' }),
      ],
      { isRoot: false },
    );

    const headings = out.match(/^## .+$/gm);
    expect(headings).toEqual(['## concept', '## note']);
    expect(out.indexOf('Apple')).toBeLessThan(out.indexOf('zebra'));
  });

  test('the description suffix is omitted entirely when there is no description', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'a.md', title: 'A', type: 'note', description: 'has one' }),
        entry({ path: 'b.md', title: 'B', type: 'note' }),
      ],
      { isRoot: false },
    );

    expect(out).toContain('* [A](./a.md) - has one');
    expect(out).toContain('* [B](./b.md)\n');
    expect(out).not.toContain('* [B](./b.md) -');
  });

  test('a multi-line description collapses to one line so it cannot break the list item', () => {
    const out = buildIndexMarkdown(
      [entry({ path: 'a.md', title: 'A', type: 'note', description: 'first\nsecond   third' })],
      { isRoot: false },
    );

    expect(out).toContain('* [A](./a.md) - first second third');
    expect(out.split('\n').filter((line) => line.startsWith('* '))).toHaveLength(1);
  });

  test('the root index carries a quoted okf_version and a non-root index carries no frontmatter', () => {
    const entries = [entry({ path: 'a.md', title: 'A', type: 'note' })];

    const root = buildIndexMarkdown(entries, { isRoot: true });
    expect(root.startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true);

    const nested = buildIndexMarkdown(entries, { isRoot: false });
    expect(nested.startsWith('---')).toBe(false);
  });

  test('links are relative with the extension retained, never a bare folder', () => {
    const out = buildIndexMarkdown(
      [entry({ path: 'concepts/nested/deep.md', title: 'Deep', type: 'concept' })],
      { isRoot: false },
    );

    expect(out).toContain('](./concepts/nested/deep.md)');
    expect(out).not.toMatch(/]\(\.\/[^)]*\/\)/);
  });

  test('an empty project yields the title alone rather than an invented section', () => {
    expect(buildIndexMarkdown([], { isRoot: true })).toBe(
      '---\nokf_version: "0.2"\n---\n\n# Index\n',
    );
    expect(buildIndexMarkdown([], { isRoot: false })).toBe('# Index\n');
  });

  test('a bucket whose members spell the heading differently renders the same either way', () => {
    const mixed = [
      entry({ path: 'a.md', title: 'Alpha', type: 'Flow' }),
      entry({ path: 'b.md', title: 'Beta', type: 'Flow #' }),
      entry({ path: 'c.md', title: 'Gamma', type: 'Café' }),
      entry({ path: 'd.md', title: 'Delta', type: 'Café' }),
    ];

    for (const isRoot of [true, false]) {
      const forward = buildIndexMarkdown(mixed, { isRoot });
      const reversed = buildIndexMarkdown(mixed.toReversed(), { isRoot });

      expect(reversed, `isRoot=${isRoot}`).toBe(forward);
      for (const href of ['](./a.md)', '](./b.md)', '](./c.md)', '](./d.md)']) {
        expect(forward, `isRoot=${isRoot} ${href}`).toContain(href);
      }
    }
  });

  test('a generator-owned heading keeps its own spelling against a colliding type', () => {
    const out = buildIndexMarkdown(
      [entry({ path: 'a.md', title: 'Alpha', type: 'Subdirectories #' })],
      { isRoot: false, subdirectories: [{ path: 'nested/index.md', title: 'nested' }] },
    );

    expect(out).toContain('## Subdirectories\n');
    expect(out).not.toContain('## Subdirectories #');
    expect(out).toContain('](./a.md)');
    expect(out).toContain('](./nested/index.md)');
  });

  test('every heading the generator owns keeps its own spelling against a colliding type', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'untyped.md', title: 'Untyped' }),
        entry({ path: 'a.md', title: 'Alpha', type: '<b></b>Other' }),
        entry({ path: 'b.md', title: 'Beta', type: '<b></b>Subdirectories' }),
        entry({ path: 'c.md', title: 'Gamma', type: '<b></b>Index' }),
      ],
      { isRoot: false, subdirectories: [{ path: 'nested/index.md', title: 'nested' }] },
    );

    expect(out).toContain('# Index\n');
    expect(out).toContain('## Other\n');
    expect(out).toContain('## Subdirectories\n');
    expect(out).not.toContain('<b>');

    for (const href of ['](./untyped.md)', '](./a.md)', '](./b.md)', '](./c.md)']) {
      expect(out, href).toContain(href);
    }
  });

  test.each([
    ...GENERATOR_OWNED_HEADINGS,
  ])('a colliding type cannot rename the generator-owned heading %j, reached from the entry loop alone', (owned) => {
    for (const order of [
      [
        entry({ path: 'a.md', title: 'Alpha', type: owned }),
        entry({ path: 'b.md', title: 'Beta', type: `<b></b>${owned}` }),
      ],
      [
        entry({ path: 'b.md', title: 'Beta', type: `<b></b>${owned}` }),
        entry({ path: 'a.md', title: 'Alpha', type: owned }),
      ],
    ]) {
      const label = `${owned} order=${order.map((e) => e.type).join(',')}`;
      const out = buildIndexMarkdown(order, { isRoot: false });

      expect(headingContents(out), label).toContain(owned);
      expect(out, label).not.toContain('<b>');
      expect(out, label).toContain('](./a.md)');
      expect(out, label).toContain('](./b.md)');
    }
  });

  test('a document sharing the title heading renders under it, byte for byte', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'readme.md', title: 'Overview', type: 'Index' }),
        entry({ path: 'login-flow.md', title: 'Login flow', type: 'Flow' }),
      ],
      { isRoot: false },
    );

    expect(out).toBe(
      '# Index\n\n* [Overview](./readme.md)\n\n## Flow\n\n* [Login flow](./login-flow.md)\n',
    );
  });

  test('the same entries in any input order produce identical bytes', () => {
    const entries = [
      entry({ path: 'b.md', title: 'Beta', type: 'note', description: 'second' }),
      entry({ path: 'a.md', title: 'Alpha', type: 'concept' }),
      entry({ path: 'c.md', title: 'Gamma', type: 'note' }),
    ];

    const forward = buildIndexMarkdown(entries, { isRoot: true });
    const reversed = buildIndexMarkdown([...entries].reverse(), { isRoot: true });
    expect(reversed).toBe(forward);
  });

  test('escapes link labels and encodes path segments without changing separators', () => {
    const out = buildIndexMarkdown(
      [
        entry({
          path: 'notes/team plan (draft) #1.md',
          title: 'A [plan]\nfor \\ everyone',
          type: 'note',
        }),
      ],
      { isRoot: false },
    );

    expect(out).toContain(
      '* [A \\[plan\\] for \\\\ everyone](./notes/team%20plan%20%28draft%29%20%231.md)',
    );
  });

  test('equal case-folded titles use normalized paths as a deterministic tie-breaker', () => {
    const entries = [
      entry({ path: 'zeta.md', title: 'Same', type: 'note' }),
      entry({ path: 'alpha.md', title: 'same', type: 'note' }),
    ];

    const forward = buildIndexMarkdown(entries, { isRoot: false });
    const reversed = buildIndexMarkdown([...entries].reverse(), { isRoot: false });

    expect(reversed).toBe(forward);
    expect(forward.indexOf('./alpha.md')).toBeLessThan(forward.indexOf('./zeta.md'));
  });

  test('collapses multiline section names into one heading', () => {
    const out = buildIndexMarkdown([entry({ path: 'a.md', title: 'A', type: 'project\n  plan' })], {
      isRoot: false,
    });

    expect(out.match(/^## .+$/gm)).toEqual(['## project plan']);
  });

  test('renders a subdirectory section alongside type sections, relative to the index directory', () => {
    const out = buildIndexMarkdown(
      [
        entry({ path: 'concepts/bounded-context.md', title: 'Bounded Context', type: 'concept' }),
        entry({ path: 'concepts/aggregate.md', title: 'Aggregate', type: 'concept' }),
      ],
      {
        isRoot: false,
        directory: 'concepts',
        subdirectories: [{ path: 'concepts/nested/index.md', title: 'nested' }],
      },
    );

    expect(out).toBe(
      [
        '# Index',
        '',
        '## concept',
        '',
        '* [Aggregate](./aggregate.md)',
        '* [Bounded Context](./bounded-context.md)',
        '',
        '## Subdirectories',
        '',
        '* [nested](./nested/index.md)',
        '',
      ].join('\n'),
    );
  });

  test('merges documents typed Subdirectories with child-directory links under one heading', () => {
    const out = buildIndexMarkdown(
      [
        entry({
          path: 'concepts/directory-notes.md',
          title: 'Directory notes',
          type: 'Subdirectories',
        }),
      ],
      {
        isRoot: false,
        directory: 'concepts',
        subdirectories: [{ path: 'concepts/nested/index.md', title: 'nested' }],
      },
    );

    expect(out).toBe(
      [
        '# Index',
        '',
        '## Subdirectories',
        '',
        '* [Directory notes](./directory-notes.md)',
        '* [nested](./nested/index.md)',
        '',
      ].join('\n'),
    );
    expect(out.match(/^## Subdirectories$/gm)).toHaveLength(1);
  });

  test('a container directory with markdown only below it lists subdirectories and no type section', () => {
    const out = buildIndexMarkdown([], {
      isRoot: false,
      directory: 'concepts',
      subdirectories: [{ path: 'concepts/nested/index.md', title: 'nested' }],
    });

    expect(out).toBe(
      ['# Index', '', '## Subdirectories', '', '* [nested](./nested/index.md)', ''].join('\n'),
    );
    expect(out).not.toMatch(/]\(\.\/[^)]*\/\)/);
    expect(out.match(/^# .+$/gm)).toEqual(['# Index']);
  });

  test('exactly one top-level heading even when a subdirectory section is present', () => {
    for (const isRoot of [true, false]) {
      const out = buildIndexMarkdown(
        [
          entry({ path: 'concepts/a.md', title: 'A', type: 'note' }),
          entry({ path: 'concepts/b.md', title: 'B', type: 'concept' }),
          entry({ path: 'concepts/c.md', title: 'C' }),
        ],
        {
          isRoot,
          directory: 'concepts',
          subdirectories: [
            { path: 'concepts/x/index.md', title: 'x' },
            { path: 'concepts/y/index.md', title: 'y' },
          ],
        },
      );

      expect(out.match(/^# .+$/gm), `isRoot=${isRoot}`).toEqual(['# Index']);
      expect(out).toContain('## Subdirectories');
    }
  });

  test('subdirectories and entries in any input order produce identical bytes', () => {
    const entries = [
      entry({ path: 'concepts/b.md', title: 'Beta', type: 'note' }),
      entry({ path: 'concepts/a.md', title: 'Alpha', type: 'concept' }),
    ];
    const subdirectories = [
      { path: 'concepts/zeta/index.md', title: 'zeta' },
      { path: 'concepts/alpha/index.md', title: 'alpha' },
    ];

    const forward = buildIndexMarkdown(entries, {
      isRoot: false,
      directory: 'concepts',
      subdirectories,
    });
    const reversed = buildIndexMarkdown([...entries].reverse(), {
      isRoot: false,
      directory: 'concepts',
      subdirectories: [...subdirectories].reverse(),
    });

    expect(reversed).toBe(forward);
  });

  test('several documents sharing a heading the generator owns produce identical bytes in any input order', () => {
    const entries = [
      entry({ path: 'concepts/overview.md', title: 'Overview', type: 'Index' }),
      entry({ path: 'concepts/catalog.md', title: 'Catalog', type: 'Index' }),
      entry({ path: 'concepts/login-flow.md', title: 'Login flow', type: 'Flow' }),
      entry({ path: 'concepts/handbook.md', title: 'Handbook', type: 'Subdirectories' }),
      entry({ path: 'concepts/atlas.md', title: 'Atlas', type: 'Subdirectories' }),
      entry({ path: 'concepts/aggregate.md', title: 'Aggregate', type: 'concept' }),
    ];
    const subdirectories = [
      { path: 'concepts/zeta/index.md', title: 'zeta' },
      { path: 'concepts/alpha/index.md', title: 'alpha' },
    ];

    for (const isRoot of [true, false]) {
      const label = `isRoot=${isRoot}`;
      const forward = buildIndexMarkdown(entries, {
        isRoot,
        directory: 'concepts',
        subdirectories,
      });
      const reversed = buildIndexMarkdown([...entries].reverse(), {
        isRoot,
        directory: 'concepts',
        subdirectories: [...subdirectories].reverse(),
      });

      expect(reversed, label).toBe(forward);

      for (const href of [
        './overview.md',
        './catalog.md',
        './handbook.md',
        './atlas.md',
        './zeta/index.md',
        './alpha/index.md',
      ]) {
        expect(forward, `${label}: ${href}`).toContain(`](${href})`);
      }
    }
  });

  test('emitted hrefs round-trip through the canonical resolver to the entry they came from', () => {
    const names = [
      'Agent Memory',
      'team plan (draft) #1',
      'R&D notes',
      "don't panic!",
      'café résumé',
    ];
    const out = buildIndexMarkdown(
      names.map((name) => entry({ path: `blogs/drafts/${name}.md`, title: name, type: 'note' })),
      { isRoot: false, directory: 'blogs/drafts' },
    );

    const hrefs = [...out.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] ?? '');
    expect(hrefs).toHaveLength(names.length);

    const resolved = hrefs.map(
      (href) => resolveInternalHref(href, 'blogs/drafts/index')?.docName ?? `<unresolved ${href}>`,
    );
    expect(resolved.toSorted()).toEqual(names.map((name) => `blogs/drafts/${name}`).toSorted());
  });

  test('no heading the generator owns collides with a section derived from a document type', () => {
    const reserved = generatorOwnedHeadings();
    expect(reserved.toSorted()).toEqual([...GENERATOR_OWNED_HEADINGS].toSorted());

    for (const type of reserved) {
      for (const isRoot of [true, false]) {
        const label = `type=${type} isRoot=${isRoot}`;
        const out = buildIndexMarkdown(
          [
            entry({ path: 'readme.md', title: 'Readme', type }),
            entry({ path: 'login-flow.md', title: 'Login flow', type: 'Flow' }),
          ],
          { isRoot, subdirectories: [{ path: 'nested/index.md', title: 'nested' }] },
        );

        expect(out, label).toContain('](./readme.md)');
        expect(out, label).toContain('](./login-flow.md)');
        expect(out, label).toContain('](./nested/index.md)');
        expect(out.match(/^# .+$/gm), label).toHaveLength(1);

        const headings = headingContents(out);
        expect(new Set(headings).size, `${label}: ${headings.join(' | ')}`).toBe(headings.length);
      }
    }
  });
});

function headingContents(markdown: string): string[] {
  return (markdown.match(/^#{1,6} .+$/gm) ?? []).map((line) => line.replace(/^#+ /, ''));
}

function generatorOwnedHeadings(): string[] {
  const probes = [false, true].flatMap((isRoot) => [
    buildIndexMarkdown([], { isRoot }),
    buildIndexMarkdown([entry({ path: 'a.md', title: 'A' })], { isRoot }),
    buildIndexMarkdown([], {
      isRoot,
      subdirectories: [{ path: 'nested/index.md', title: 'nested' }],
    }),
  ]);

  return [...new Set(probes.flatMap(headingContents))];
}
