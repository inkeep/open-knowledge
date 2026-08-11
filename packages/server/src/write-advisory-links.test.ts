import { describe, expect, test } from 'vitest';
import { computeWriteAdvisoryLinks, type WriteAdvisoryLink } from './write-advisory-links.ts';

/** Existence oracle from a fixed set of content-root-relative file paths. */
function fileOracle(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths);
  return (rel) => set.has(rel);
}

describe('computeWriteAdvisoryLinks', () => {
  test('reports graph-shaped links (doc, file, wiki) with no evidence, exactly as before', () => {
    const md = ['See [guide](./guide) and [data](./data.csv).', 'A [[Ghost]] wiki reference.'].join(
      '\n',
    );
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), fileOracle());
    // Document (inline + wiki) and ordinary-file LINKS are the graph scan's
    // pre-existing contract — a plain triple with no local-target evidence.
    expect(links).toEqual([
      { href: './guide', resolvedTo: 'guide', reason: 'no-such-doc' },
      { href: './data.csv', resolvedTo: 'data.csv', reason: 'no-such-file' },
      { href: '[[Ghost]]', resolvedTo: 'Ghost', reason: 'no-such-doc' },
    ]);
    for (const link of links) expect(link.localTarget).toBeUndefined();
  });

  test('adds a missing Markdown image as a file finding with local-target evidence', () => {
    const links = computeWriteAdvisoryLinks(
      '![logo](./logo.png)\n',
      'notes',
      new Set<string>(),
      fileOracle(),
    );
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
      fileOracle(),
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
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), fileOracle());
    // Two uses of one reference resolve to one href — deduped to a single write
    // advisory entry that carries the definition repair pointer.
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
    const links = computeWriteAdvisoryLinks(md, 'source', new Set(['Guide']), fileOracle());

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
    const links = computeWriteAdvisoryLinks(
      '![ok](./ok.png)\n',
      'notes',
      new Set<string>(),
      fileOracle('ok.png'),
    );
    expect(links).toEqual([]);
  });

  test('reports a root-escaping image as unresolvable (path arithmetic, oracle-independent)', () => {
    const links = computeWriteAdvisoryLinks(
      '![out](../../../out.png)\n',
      'notes',
      new Set<string>(),
      fileOracle('anything'),
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
      fileOracle(),
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
      fileOracle(),
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

    expect(computeWriteAdvisoryLinks(markdown, 'notes', new Set<string>(), fileOracle())).toEqual(
      [],
    );
  });

  test('preserves separate reference definitions that share one missing href', () => {
    const md = ['[a][one] and [b][two]', '', '[one]: ./missing.pdf', '[two]: ./missing.pdf'].join(
      '\n',
    );
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), fileOracle());

    expect(links).toHaveLength(2);
    expect(links.map((link) => link.localTarget?.definition)).toEqual([
      { line: 2, label: 'one' },
      { line: 3, label: 'two' },
    ]);
  });

  test('dedups repeated uses of the same shared reference definition', () => {
    const md = '[a][same] and [b][same]\n\n[same]: ./missing.pdf';
    const links = computeWriteAdvisoryLinks(md, 'notes', new Set<string>(), fileOracle());

    expect(links).toHaveLength(1);
    expect(links[0]?.localTarget?.definition).toEqual({ line: 2, label: 'same' });
  });

  test('does not re-report an inline document link the graph scan already covered', () => {
    const links = computeWriteAdvisoryLinks(
      '[guide](./guide)\n',
      'notes',
      new Set<string>(),
      fileOracle(),
    );
    expect(links).toEqual([{ href: './guide', resolvedTo: 'guide', reason: 'no-such-doc' }]);
  });

  test('without a filesystem oracle, skips file/image findings but keeps document findings', () => {
    const links = computeWriteAdvisoryLinks(
      '[g](./g) and ![i](./i.png)\n',
      'notes',
      new Set<string>(),
    );
    expect(links).toEqual([{ href: './g', resolvedTo: 'g', reason: 'no-such-doc' }]);
  });

  test('does not report a resolved link/image mix (all targets exist)', () => {
    const links = computeWriteAdvisoryLinks(
      '[home](./home.md) and ![pic](./pic.png)\n',
      'notes',
      new Set(['home']),
      fileOracle('pic.png'),
    );
    expect(links).toEqual([]);
  });
});
