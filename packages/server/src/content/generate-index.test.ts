import { resolveInternalHref } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { buildIndexMarkdown, type IndexEntry } from './generate-index.ts';

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
    // Several level-one headings in one file is MD025, which markdownlint's
    // default profile has on. The section level is therefore load-bearing, not
    // cosmetic: it is what keeps a generated file from lighting up the Problems
    // list in a project the author cannot edit their way out of.
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
    // 'Apple' before 'zebra' requires the comparison to ignore case; a
    // case-sensitive sort puts every capitalized title first.
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
    // A trailing-slash href resolves to a DOCUMENT of that name — there is no
    // folder variant in ClassifiedLinkTarget — so it would read as broken.
    expect(out).not.toMatch(/]\(\.\/[^)]*\/\)/);
  });

  test('an empty project yields the title alone rather than an invented section', () => {
    expect(buildIndexMarkdown([], { isRoot: true })).toBe(
      '---\nokf_version: "0.2"\n---\n\n# Index\n',
    );
    expect(buildIndexMarkdown([], { isRoot: false })).toBe('# Index\n');
  });

  test('the same entries in any input order produce identical bytes', () => {
    const entries = [
      entry({ path: 'b.md', title: 'Beta', type: 'note', description: 'second' }),
      entry({ path: 'a.md', title: 'Alpha', type: 'concept' }),
      entry({ path: 'c.md', title: 'Gamma', type: 'note' }),
    ];

    // The write guard compares bytes to decide whether to touch the file, so an
    // ordering that depends on input order would make every rebuild a write.
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
        // Rebased to the index's own directory: 'concepts/aggregate.md' -> './aggregate.md'.
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
    // A child link targets the child index document; a trailing-slash folder
    // href resolves to a document of that name and reads as broken.
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

  test('emitted hrefs round-trip through the canonical resolver to the entry they came from', () => {
    // The generator's percent-encoding is the only CommonMark-valid way to link
    // these names (a literal space does not parse as an unbracketed link
    // destination), so the encoded href must resolve back to the original
    // docName through the same resolver every link surface consumes
    // (precedent #56). A generated index whose own validator flags its links
    // as dead is the failure this pins against.
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
});
