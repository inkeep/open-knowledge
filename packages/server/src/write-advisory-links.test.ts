import { describe, expect, test } from 'vitest';
import {
  computeWriteAdvisoryLinks,
  type WriteAdvisoryLink,
  type WriteAdvisoryTargets,
} from './write-advisory-links.ts';

const NO_TARGETS: WriteAdvisoryTargets = {
  fileExists: null,
  folderExists: null,
  fileExcluded: null,
  resolveWikiFile: null,
  resolveFileByBasename: null,
};

const NOTHING_TRACKED: WriteAdvisoryTargets = {
  fileExists: () => false,
  folderExists: () => false,
  fileExcluded: () => false,
  resolveWikiFile: () => undefined,
  resolveFileByBasename: () => undefined,
};

function fileOracle(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths);
  return (rel) => set.has(rel);
}

describe('computeWriteAdvisoryLinks', () => {
  test('a folder oracle exempts wiki and inline links to existing folders (both planes)', () => {
    const md = 'See [[assets]] and [dir](./assets) and [[missing-folder]].';
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NO_TARGETS,
      folderExists: (folderPath) => folderPath === 'assets',
    });
    expect(links.map((link) => link.href)).toEqual(['[[missing-folder]]']);
  });

  test('NFC links to NFD documents and folders are not advisory', () => {
    const md = 'See [r](people/Ren\u00e9.md), [[people/Ren\u00e9]] and [dir](Ren\u00e9).';
    const links = computeWriteAdvisoryLinks(
      md,
      'notes',
      new Set(['people/Rene\u0301', 'Rene\u0301/inner']),
      { ...NOTHING_TRACKED, fileExists: fileOracle() },
    );
    expect(links).toEqual([]);
  });

  test('a wiki asset target resolves across folder case through the wiki file resolver', () => {
    const md = 'See ![[pics/deep/x.png]], [[PICS/Deep/X.png]] and ![[pics/deep/nope.png]].\n';
    const tracked: Record<string, string> = { 'pics/deep/x.png': 'Pics/Deep/x.png' };
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle('Pics/Deep/x.png'),
      resolveWikiFile: (rel) => tracked[rel.toLowerCase()],
    });
    expect(links.map((link) => link.href)).toEqual(['pics/deep/nope.png']);
  });

  test('reports graph-shaped links (doc, file, wiki) with no evidence, exactly as before', () => {
    const md = ['See [guide](./guide) and [data](./data.csv).', 'A [[Ghost]] wiki reference.'].join(
      '\n',
    );
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });
    expect(links).toEqual([
      { href: './guide', resolvedTo: 'guide', reason: 'no-such-doc' },
      { href: './data.csv', resolvedTo: 'data.csv', reason: 'no-such-file' },
      { href: '[[Ghost]]', resolvedTo: 'Ghost', reason: 'no-such-doc' },
    ]);
    for (const link of links) expect(link.localTarget).toBeUndefined();
  });

  test('adds a missing Markdown image as a file finding with local-target evidence', () => {
    const links = computeWriteAdvisoryLinks('![logo](./logo.png)\n', 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });
    expect(links).toEqual([
      {
        href: './logo.png',
        resolvedTo: 'logo.png',
        reason: 'no-such-file',
        localTarget: {
          href: './logo.png',
          targetKind: 'file',
          role: 'image',
          sourceForm: 'markdown-inline',
          resolvedTarget: 'logo.png',
          reason: 'no-such-file',
          resolutionMethod: 'source-relative',
        },
      },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('adds a missing HTML img source as an html-img image finding', () => {
    const links = computeWriteAdvisoryLinks(
      '<img src="./banner.png" alt="banner">\n',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle() },
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.localTarget).toEqual({
      href: './banner.png',
      targetKind: 'file',
      role: 'image',
      sourceForm: 'html-img',
      resolvedTarget: 'banner.png',
      reason: 'no-such-file',
      resolutionMethod: 'source-relative',
    });
  });

  test('adds a reference-style target once, pointing at its shared definition', () => {
    const md = ['See [the spec][spec] and [again][spec].', '', '[spec]: ./spec.pdf'].join('\n');
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });
    expect(links).toEqual([
      {
        href: './spec.pdf',
        resolvedTo: 'spec.pdf',
        reason: 'no-such-file',
        localTarget: {
          href: './spec.pdf',
          targetKind: 'file',
          role: 'link',
          sourceForm: 'markdown-reference',
          resolvedTarget: 'spec.pdf',
          reason: 'no-such-file',
          resolutionMethod: 'source-relative',
          definition: { line: 2, label: 'spec' },
        },
      },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('preserves a reference-style document fallback target without blessing it exact', () => {
    const md = ['See [the guide][guide].', '', '[guide]: guide'].join('\n');
    const links = computeWriteAdvisoryLinks(md, 'source', new Set(['Guide']), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });

    expect(links).toEqual([
      {
        href: 'guide',
        resolvedTo: 'guide',
        reason: 'no-such-doc',
        localTarget: {
          href: 'guide',
          targetKind: 'document',
          role: 'link',
          sourceForm: 'markdown-reference',
          resolvedTarget: 'guide',
          reason: 'no-such-doc',
          resolutionMethod: 'tolerant',
          fallbackTarget: 'Guide',
          definition: { line: 2, label: 'guide' },
        },
      },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('does not report an image whose target exists', () => {
    const links = computeWriteAdvisoryLinks('![ok](./ok.png)\n', 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle('ok.png'),
    });
    expect(links).toEqual([]);
  });

  test('reports a root-escaping image as unresolvable (path arithmetic, oracle-independent)', () => {
    const links = computeWriteAdvisoryLinks(
      '![out](../../../out.png)\n',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle('anything') },
    );
    expect(links).toEqual([
      {
        href: '../../../out.png',
        resolvedTo: null,
        reason: 'unresolvable',
        localTarget: {
          href: '../../../out.png',
          targetKind: 'file',
          role: 'image',
          sourceForm: 'markdown-inline',
          resolvedTarget: null,
          reason: 'unresolvable',
          resolutionMethod: 'none',
        },
      },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('preserves distinct link and image repair sites sharing one href', () => {
    const links = computeWriteAdvisoryLinks(
      '[x](./both.png) and ![y](./both.png)\n',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle() },
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({
      href: './both.png',
      resolvedTo: 'both.png',
      reason: 'no-such-file',
    });
    expect(links[1]?.localTarget).toMatchObject({ role: 'image', href: './both.png' });
  });

  test('a badge link reports the outer link and nested image without a synthetic duplicate', () => {
    const links = computeWriteAdvisoryLinks(
      '[![badge](./badge.png)](./target.md)',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle() },
    );

    expect(links).toHaveLength(2);
    expect(links.map((link) => [link.localTarget?.role, link.href])).toEqual([
      ['link', './target.md'],
      ['image', './badge.png'],
    ]);
  });

  test('does not report markdown-looking links from non-rendering contexts', () => {
    const markdown = [
      '<!-- [comment](./comment.pdf) -->',
      '    [indented](./indented.pdf)',
      '<pre>[raw](./raw.pdf)</pre>',
    ].join('\n');

    expect(
      computeWriteAdvisoryLinks(markdown, 'notes', new Set<string>(), {
        ...NOTHING_TRACKED,
        fileExists: fileOracle(),
      }),
    ).toEqual([]);
  });

  test('preserves separate reference definitions that share one missing href', () => {
    const md = ['[a][one] and [b][two]', '', '[one]: ./missing.pdf', '[two]: ./missing.pdf'].join(
      '\n',
    );
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });

    expect(links).toHaveLength(2);
    expect(links.map((link) => link.localTarget?.definition)).toEqual([
      { line: 2, label: 'one' },
      { line: 3, label: 'two' },
    ]);
  });

  test('dedups repeated uses of the same shared reference definition', () => {
    const md = '[a][same] and [b][same]\n\n[same]: ./missing.pdf';
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.localTarget?.definition).toEqual({ line: 2, label: 'same' });
  });

  test('does not re-report an inline document link the graph scan already covered', () => {
    const links = computeWriteAdvisoryLinks('[guide](./guide)\n', 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });
    expect(links).toEqual([{ href: './guide', resolvedTo: 'guide', reason: 'no-such-doc' }]);
  });

  test('without a filesystem oracle, judges only document links that cannot name a file', () => {
    const links = computeWriteAdvisoryLinks(
      '[g](./g), [m](./Makefile), [r][g], [[w]], <Mirror src="m" /> and ![i](./i.png)\n\n[g]: ./g\n',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: null },
    );
    expect(links).toEqual([
      { href: '[[w]]', resolvedTo: 'w', reason: 'no-such-doc' },
      { href: 'm', resolvedTo: 'm', reason: 'no-such-doc', sourceForm: 'jsx' },
    ]);
  });

  test('does not report a resolved link/image mix (all targets exist)', () => {
    const links = computeWriteAdvisoryLinks(
      '[home](./home.md) and ![pic](./pic.png)\n',
      'notes',
      new Set(['home']),
      { ...NOTHING_TRACKED, fileExists: fileOracle('pic.png') },
    );
    expect(links).toEqual([]);
  });

  test('a JSX src-ref to a missing board survives the inline-href reconciliation filter', () => {
    const links = computeWriteAdvisoryLinks(
      '<Excalidraw src="board.excalidraw" />\n',
      'notes/index',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle() },
    );
    expect(links).toEqual([
      {
        href: 'board.excalidraw',
        resolvedTo: 'notes/board.excalidraw',
        reason: 'no-such-file',
        sourceForm: 'jsx',
      },
    ]);
  });

  test('a JSX src-ref to an existing board reports nothing', () => {
    const links = computeWriteAdvisoryLinks(
      '<Excalidraw src="board.excalidraw" /> and <Mirror src="api-spec" anchor="x" />\n',
      'notes/index',
      new Set(['api-spec']),
      { ...NOTHING_TRACKED, fileExists: fileOracle('notes/board.excalidraw') },
    );
    expect(links).toEqual([]);
  });

  test('a JSX src-ref survives when a markdown-looking link with the identical href scans first', () => {
    const md = ['<!-- [b](board.excalidraw) -->', '<Excalidraw src="board.excalidraw" />', ''].join(
      '\n',
    );
    const links = computeWriteAdvisoryLinks(md, 'notes/index', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExists: fileOracle(),
    });
    expect(links).toEqual([
      expect.objectContaining({
        href: 'board.excalidraw',
        resolvedTo: 'notes/board.excalidraw',
        reason: 'no-such-file',
        sourceForm: 'jsx',
      }),
    ]);
  });
});

describe('file targets that exist but are excluded by ignore rules (PRD-8896)', () => {
  test('reports excluded on both the graph plane and the evidence plane; missing stays no-such-file', () => {
    const excluded = new Set(['ig.png']);
    const links = computeWriteAdvisoryLinks(
      '[d](./ig.png)\n![e](./ig.png)\n[m](./missing.png)\n',
      'notes',
      new Set<string>(),
      { ...NOTHING_TRACKED, fileExists: fileOracle(), fileExcluded: (rel) => excluded.has(rel) },
    );
    expect(links).toEqual([
      { href: './ig.png', resolvedTo: 'ig.png', reason: 'excluded' },
      { href: './missing.png', resolvedTo: 'missing.png', reason: 'no-such-file' },
      {
        href: './ig.png',
        resolvedTo: 'ig.png',
        reason: 'excluded',
        localTarget: {
          href: './ig.png',
          targetKind: 'file',
          role: 'image',
          sourceForm: 'markdown-inline',
          resolvedTarget: 'ig.png',
          reason: 'excluded',
          resolutionMethod: 'source-relative',
        },
      },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('a Markdown link naming no document is judged as the file it names', () => {
    const links = computeWriteAdvisoryLinks(
      '[m](./Makefile), [n](./ignored/NOTICE) and [g](./gone)\n',
      'notes',
      new Set<string>(),
      {
        ...NOTHING_TRACKED,
        fileExists: fileOracle('Makefile'),
        fileExcluded: (rel) => rel === 'ignored/NOTICE',
      },
    );
    expect(links).toEqual([
      { href: './ignored/NOTICE', resolvedTo: 'ignored/NOTICE', reason: 'excluded' },
      { href: './gone', resolvedTo: 'gone', reason: 'no-such-doc' },
    ] satisfies WriteAdvisoryLink[]);
  });

  test('without the exclusion probe a file missing from the list gets no verdict', () => {
    const links = computeWriteAdvisoryLinks('[d](./ig.png)\n', 'notes', new Set<string>(), {
      ...NOTHING_TRACKED,
      fileExcluded: null,
    });
    expect(links).toEqual([]);
  });
});

describe('a null capability gives the targets it judges no verdict, never missing (PRD-8896)', () => {
  const rows: Array<[keyof WriteAdvisoryTargets, string, string[]]> = [
    ['fileExists', 'See ![i](./i.png) and [m](./Makefile).\n', ['./Makefile', './i.png']],
    ['folderExists', 'See [dir](./assets) and [[assets]].\n', ['./assets', '[[assets]]']],
    [
      'fileExcluded',
      'See [d](./ig.png), ![e](./ig.png) and [m](./Makefile).\n',
      ['./ig.png', './Makefile', './ig.png'],
    ],
    ['resolveWikiFile', 'See ![[Images/cat.png]].\n', ['Images/cat.png']],
    ['resolveFileByBasename', 'See ![[cat.png]].\n', ['cat.png']],
  ];

  test('every capability has a row', () => {
    expect(rows.map(([capability]) => capability).sort()).toEqual(Object.keys(NO_TARGETS).sort());
  });

  for (const [capability, md, reportedWhenNothingIsTracked] of rows) {
    test(`${capability}: null withholds what an oracle that knows nothing would report`, () => {
      const hrefs = (targets: WriteAdvisoryTargets): string[] =>
        computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), targets).map((link) => link.href);
      expect(hrefs(NOTHING_TRACKED)).toEqual(reportedWhenNothingIsTracked);
      expect(hrefs({ ...NOTHING_TRACKED, [capability]: null })).toEqual([]);
    });
  }
});
