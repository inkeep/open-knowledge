import { createBasenameIndex, createTargetNamespace } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  assessLocalTargetOccurrences,
  assessLocalTargets,
  buildLocalTargetEvidence,
  createTolerantDocumentResolver,
  isProjectableToLocalTargetSurfaces,
  type LocalTargetInventory,
  toForwardLinkLocalTargets,
} from './local-target-assessment.ts';
import { extractLocalTargetOccurrences } from './local-target-occurrences.ts';

function inventory(opts?: {
  docs?: Iterable<string>;
  files?: Iterable<string>;
  tolerant?: Record<string, string>;
  excluded?: Iterable<string>;
}): LocalTargetInventory {
  const docs = createTargetNamespace('document', opts?.docs ?? []);
  const files = createTargetNamespace('file', opts?.files ?? []);
  const basenames = createBasenameIndex();
  for (const file of files) basenames.add(file);
  const tolerant = opts?.tolerant;
  const excluded = opts?.excluded === undefined ? null : new Set(opts.excluded);
  const base: LocalTargetInventory = {
    resolveDocument: (docName) => docs.resolve(docName),
    resolveFile: (filePath) => files.resolve(filePath),
    resolveFileByBasename: (basename, sourceDocName) =>
      basenames.resolveEmbed(basename, sourceDocName) ?? undefined,
    ...(excluded === null ? {} : { isExcludedFile: (filePath) => excluded.has(filePath) }),
  };
  if (!tolerant) return base;
  return { ...base, resolveTolerantDocument: (docName) => tolerant[docName] ?? null };
}

const SOURCE = 'notes/index';

function assessOne(markdown: string, inv: LocalTargetInventory) {
  const [assessment, ...rest] = assessLocalTargets(markdown, SOURCE, inv);
  expect(rest).toEqual([]);
  return assessment;
}

describe('canonical assessment per authored form', () => {
  test('inline markdown link to an existing document is exact', () => {
    const a = assessOne('[see](./guide.md)', inventory({ docs: ['notes/guide'] }));
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'notes/guide',
      status: 'exact',
      reason: null,
      resolutionMethod: 'source-relative',
      fallbackTarget: null,
    });
    expect(a?.occurrence.role).toBe('link');
  });

  test('inline markdown image resolves to a file, not a document', () => {
    const a = assessOne('![alt](./diagram.png)', inventory({ files: ['notes/diagram.png'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/diagram.png',
      status: 'exact',
      reason: null,
    });
    expect(a?.occurrence.role).toBe('image');
  });

  test('HTML img src resolves to a file target', () => {
    const a = assessOne('<img src="./photo.png">', inventory({ files: ['notes/photo.png'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/photo.png',
      status: 'exact',
    });
  });

  test('reference-style use assesses its shared definition destination', () => {
    const a = assessOne('[a][d]\n\n[d]: ./manual.pdf', inventory({ files: ['notes/manual.pdf'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/manual.pdf',
      status: 'exact',
      reason: null,
    });
    expect(a?.occurrence.sourceForm).toBe('markdown-reference');
  });
});

describe('document vs ordinary-file membership', () => {
  test('an extension-less link resolves to an exact ordinary file when no document exists', () => {
    const a = assessOne('[license](../LICENSE)', inventory({ files: ['LICENSE'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'LICENSE',
      status: 'exact',
      reason: null,
    });
  });

  test('a missing document link with a .md path is never satisfied by a file of that path', () => {
    const a = assessOne(
      '[g](./Guide.md)',
      inventory({ docs: ['notes/guide'], files: ['notes/Guide.md'] }),
    );
    expect(a).toMatchObject({ targetKind: 'document', status: 'missing', reason: 'no-such-doc' });
  });

  test('an exact document wins when both extension-less target kinds exist', () => {
    const a = assessOne(
      '[target](./guide)',
      inventory({ docs: ['notes/guide'], files: ['notes/guide'] }),
    );
    expect(a).toMatchObject({ targetKind: 'document', status: 'exact' });
  });

  test('an extension-less image is assessed as a file', () => {
    const a = assessOne('![badge](./BADGE)', inventory({ files: ['notes/BADGE'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/BADGE',
      status: 'exact',
    });
  });

  test('the same extension-less href is cached independently for link and image roles', () => {
    const assessments = assessLocalTargets(
      '[guide](./guide) ![guide](./guide)',
      SOURCE,
      inventory({ docs: ['notes/guide'], files: ['notes/guide'] }),
    );
    expect(assessments.map(({ targetKind }) => targetKind)).toEqual(['document', 'file']);
    expect(assessments.every(({ status }) => status === 'exact')).toBe(true);
  });

  test('a document href absent from the admitted set is a missing document', () => {
    const a = assessOne('[see](./guide.md)', inventory({ docs: [], files: ['notes/guide'] }));
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'notes/guide',
      status: 'missing',
      reason: 'no-such-doc',
    });
  });

  test('a file href absent from the file inventory is a missing file', () => {
    const a = assessOne(
      '[data](./report.csv)',
      inventory({ docs: ['notes/report.csv'], files: [] }),
    );
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/report.csv',
      status: 'missing',
      reason: 'no-such-file',
    });
  });

  test('document and file oracles are consulted independently for the same document', () => {
    const a = assessOne('[see](./guide.md)', inventory({ files: ['notes/guide'] }));
    expect(a?.status).toBe('missing');
    expect(a?.reason).toBe('no-such-doc');
  });

  test('root-relative resolution records its own method', () => {
    const a = assessOne('[x](/root/file.md)', inventory({ docs: ['root/file'] }));
    expect(a).toMatchObject({
      resolvedTarget: 'root/file',
      status: 'exact',
      resolutionMethod: 'root-relative',
    });
  });
});

describe('exact existence is authoritative; tolerant navigation is explicit, never exact', () => {
  test('a missing document with a tolerant match is fallback, not exact', () => {
    const a = assessOne(
      '[g](./guide.md)',
      inventory({ docs: [], tolerant: { 'notes/guide': 'guides/guide' } }),
    );
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'notes/guide',
      status: 'fallback',
      reason: 'no-such-doc',
      resolutionMethod: 'tolerant',
      fallbackTarget: 'guides/guide',
    });
  });

  test('an exact hit is never downgraded even when a tolerant match also exists', () => {
    const a = assessOne(
      '[g](./guide.md)',
      inventory({ docs: ['notes/guide'], tolerant: { 'notes/guide': 'somewhere/else' } }),
    );
    expect(a?.status).toBe('exact');
    expect(a?.fallbackTarget).toBeNull();
    expect(a?.resolutionMethod).toBe('source-relative');
  });

  test('files have no tolerant fallback — an absent file stays missing', () => {
    const a = assessOne(
      '![p](./photo.png)',
      inventory({ files: [], tolerant: { 'notes/photo.png': 'anything' } }),
    );
    expect(a?.status).toBe('missing');
    expect(a?.reason).toBe('no-such-file');
    expect(a?.fallbackTarget).toBeNull();
  });
});

describe('ignored and escaping targets are classified without admitting them', () => {
  test('a traversal-escaping document path is unresolvable, not missing', () => {
    const a = assessOne('[x](../../../../etc/passwd)', inventory());
    expect(a).toMatchObject({
      targetKind: 'unknown',
      resolvedTarget: null,
      status: 'unresolvable',
      reason: 'unresolvable',
      resolutionMethod: 'none',
    });
  });

  test('a traversal-escaping file path is unresolvable rather than a missing file', () => {
    const a = assessOne('![x](../../../../etc/photo.png)', inventory());
    expect(a).toMatchObject({ targetKind: 'file', resolvedTarget: null, status: 'unresolvable' });
  });

  test('a same-named file entry never satisfies an escaping href', () => {
    const a = assessOne('[x](../../secrets/passwd)', inventory({ files: ['secrets/passwd'] }));
    expect(a?.status).toBe('unresolvable');
  });
});

describe('repeated occurrences share existence work while each keeps its range', () => {
  test('the inventory is consulted once per distinct href, and every occurrence is assessed', () => {
    const md = 'One [a](./x.md) two [b](./x.md) three [c](./y.md).';
    let docLookups = 0;
    const inv: LocalTargetInventory = {
      resolveDocument: (docName) => {
        docLookups += 1;
        return docName === 'notes/x' ? docName : undefined;
      },
      resolveFile: () => undefined,
    };
    const assessments = assessLocalTargetOccurrences(
      extractLocalTargetOccurrences(md),
      SOURCE,
      inv,
    );
    expect(assessments).toHaveLength(3);
    expect(docLookups).toBe(2);
    for (const a of assessments) {
      expect(md.slice(a.occurrence.range.start, a.occurrence.range.end)).toContain(
        a.occurrence.href,
      );
    }
    const toX = assessments.filter((a) => a.resolvedTarget === 'notes/x');
    expect(toX).toHaveLength(2);
    expect(toX.every((a) => a.status === 'exact')).toBe(true);
    expect(toX[0]?.occurrence.range).not.toEqual(toX[1]?.occurrence.range);
  });
});

describe('scope: classification is total across every recognized form', () => {
  test('wiki link and wiki embed occurrences are classified alongside markdown forms', () => {
    const md = 'A [[Some Page]] and an embed ![[photo.png]] plus [real](./r.md).';
    const assessments = assessLocalTargets(md, SOURCE, inventory({ docs: ['notes/r'] }));
    expect(assessments.map((a) => a.occurrence.sourceForm)).toEqual([
      'wiki-link',
      'wiki-embed',
      'markdown-inline',
    ]);
  });

  test('an extension-less wiki embed is document-shaped, not file-shaped', () => {
    const a = assessLocalTargets('![[targets/missing-embed]]', SOURCE, inventory())[0];
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'targets/missing-embed',
      status: 'missing',
      reason: 'no-such-doc',
    });
  });

  test('an extension-bearing wiki embed stays file-shaped and resolves by vault-wide basename', () => {
    const a = assessLocalTargets(
      '![[photo.png]]',
      SOURCE,
      inventory({ files: ['notes/photo.png'] }),
    )[0];
    expect(a).toMatchObject({
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: 'notes/photo.png',
      reason: null,
      resolutionMethod: 'basename',
    });
  });

  test('a basename wiki embed prefers the candidate nearest the source, like the embed renderer', () => {
    const a = assessLocalTargets(
      '![[photo.png]]',
      SOURCE,
      inventory({ files: ['media/photo.png', 'notes/photo.png'] }),
    )[0];
    expect(a).toMatchObject({ status: 'exact', resolvedTarget: 'notes/photo.png' });
  });

  test('a basename wiki embed resolves across canonically equivalent spellings', () => {
    const a = assessLocalTargets(
      '![[Café.png]]',
      SOURCE,
      inventory({ files: ['media/Café.png'] }),
    )[0];
    expect(a).toMatchObject({
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: 'media/Café.png',
    });
  });

  test('a wiki asset path resolves against the vault root, never the source folder', () => {
    const atRoot = assessLocalTargets(
      '[[assets/x.png]]',
      SOURCE,
      inventory({ files: ['assets/x.png'] }),
    )[0];
    expect(atRoot).toMatchObject({
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: 'assets/x.png',
      resolutionMethod: 'root-relative',
    });

    const besideSource = assessLocalTargets(
      '[[assets/x.png]]',
      SOURCE,
      inventory({ files: ['notes/assets/x.png'] }),
    )[0];
    expect(besideSource).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'assets/x.png',
    });
  });

  test('a missing wiki asset target is a missing file, by basename or by path', () => {
    const rows = assessLocalTargets(
      '![[nothere.gif]] and [[media/nothere.png]]',
      SOURCE,
      inventory({ files: ['media/photo.png'] }),
    );
    expect(rows.map((r) => [r.occurrence.sourceForm, r.occurrence.role])).toEqual([
      ['wiki-embed', 'image'],
      ['wiki-link', 'link'],
    ]);
    expect(rows[0]).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'nothere.gif',
    });
    expect(rows[1]).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'media/nothere.png',
    });
  });

  test('a dotted bare wiki name that names a document is assessed as a document link the surfaces leave to the graph', () => {
    const docs = ['vault/acp.daemon'];
    const resolveTolerant = createTolerantDocumentResolver(docs);
    const rows = assessLocalTargets('[[acp.daemon]], ![[ACP.Daemon]] and [[gone.daemon]]', SOURCE, {
      ...inventory({ docs }),
      resolveTolerantDocument: (docName) => resolveTolerant(docName),
    });
    expect(
      rows.map((r) => [
        r.occurrence.href,
        r.targetKind,
        r.status,
        r.reason,
        r.fallbackTarget,
        isProjectableToLocalTargetSurfaces(r),
      ]),
    ).toEqual([
      ['acp.daemon', 'document', 'fallback', 'no-such-doc', 'vault/acp.daemon', false],
      ['ACP.Daemon', 'document', 'fallback', 'no-such-doc', 'vault/acp.daemon', false],
      ['gone.daemon', 'file', 'missing', 'no-such-file', null, true],
    ]);
  });

  test('a wiki target resolves entirely against the vault root, fallback included', () => {
    const a = assessLocalTargets(
      '[[assets/NOTICE]]',
      SOURCE,
      inventory({ files: ['assets/NOTICE', 'notes/assets/NOTICE'] }),
    )[0];
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'assets/NOTICE',
      status: 'missing',
    });
  });

  test('the same extension-less href resolves per form, not per href', () => {
    const md = '![md image](assets/NOTICE)\n\n![[assets/NOTICE]]\n';
    const rows = assessLocalTargets(md, SOURCE, inventory({ files: ['assets/NOTICE'] }));
    expect(rows.map((r) => [r.occurrence.sourceForm, r.targetKind])).toEqual([
      ['markdown-inline', 'file'],
      ['wiki-embed', 'document'],
    ]);
  });
});

describe('toForwardLinkLocalTargets — Links panel Local files projection', () => {
  test('projects file and image references but excludes document graph edges and document-shaped wiki links', () => {
    const md = [
      '[report](./report.pdf)',
      '![logo](./logo.png)',
      '<img src="./pic.png">',
      '[other](./other.md)',
      '[[wiki]]',
      '![[missing.png]]',
      '[[docs/spec.pdf]]',
    ].join('\n');
    const rows = toForwardLinkLocalTargets(
      assessLocalTargets(
        md,
        SOURCE,
        inventory({ docs: ['notes/other'], files: ['notes/logo.png', 'docs/spec.pdf'] }),
      ),
    );

    expect(rows.map((r) => r.href).sort()).toEqual([
      './logo.png',
      './pic.png',
      './report.pdf',
      'docs/spec.pdf',
      'missing.png',
    ]);
    expect(rows.some((r) => r.targetKind === 'document')).toBe(false);
    expect(rows.find((r) => r.href === 'missing.png')).toMatchObject({
      role: 'image',
      sourceForm: 'wiki-embed',
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'missing.png',
    });
    expect(rows.find((r) => r.href === 'docs/spec.pdf')).toMatchObject({
      role: 'link',
      sourceForm: 'wiki-link',
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: 'docs/spec.pdf',
    });

    const report = rows.find((r) => r.href === './report.pdf');
    expect(report).toMatchObject({
      role: 'link',
      sourceForm: 'markdown-inline',
      targetKind: 'file',
      resolvedTarget: 'notes/report.pdf',
      status: 'missing',
      reason: 'no-such-file',
      definition: null,
    });
    expect(report && md.slice(report.range.start, report.range.end)).toBe('[report](./report.pdf)');

    expect(rows.find((r) => r.href === './logo.png')).toMatchObject({
      role: 'image',
      targetKind: 'file',
      status: 'exact',
      reason: null,
    });
    expect(rows.find((r) => r.href === './pic.png')).toMatchObject({
      role: 'image',
      sourceForm: 'html-img',
      status: 'missing',
      reason: 'no-such-file',
    });
  });

  test('a reference-style file use carries its shared definition pointer', () => {
    const md = '[grab][data]\n\n[data]: ./data.csv\n';
    const rows = toForwardLinkLocalTargets(assessLocalTargets(md, SOURCE, inventory({})));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'link',
      sourceForm: 'markdown-reference',
      status: 'missing',
      reason: 'no-such-file',
      resolvedTarget: 'notes/data.csv',
      definition: { label: 'data', line: 2 },
    });
  });

  test('repeated references to one file yield one row each, never a deduplicated edge', () => {
    const md = '![a](./x.png) and again ![a](./x.png)';
    const rows = toForwardLinkLocalTargets(assessLocalTargets(md, SOURCE, inventory({})));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.href === './x.png' && r.status === 'missing')).toBe(true);
    expect(rows[0]?.range).not.toEqual(rows[1]?.range);
  });

  test('an image whose path escapes the content root is surfaced as unresolvable, not dropped', () => {
    const rows = toForwardLinkLocalTargets(
      assessLocalTargets('![up](../../secret.png)', SOURCE, inventory({})),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'image',
      status: 'unresolvable',
      resolvedTarget: null,
    });
  });

  test('a document link and an unresolvable link produce no Local files rows', () => {
    const md = '[doc](./other.md) and [[wiki]] and [esc](../../nowhere)';
    const rows = toForwardLinkLocalTargets(
      assessLocalTargets(md, SOURCE, inventory({ docs: ['notes/other'] })),
    );
    expect(rows).toEqual([]);
  });

  test('Problems evidence carries a file-shaped wiki occurrence and still drops a document-shaped one', () => {
    const rows = assessLocalTargets('[[ghost]] and ![[ghost.png]]', SOURCE, inventory({}));
    expect(rows).toHaveLength(2);
    const [doc, file] = rows;
    expect(doc && buildLocalTargetEvidence(doc, 'no-such-doc')).toBeNull();
    expect(file && buildLocalTargetEvidence(file, 'no-such-file')).toEqual({
      href: 'ghost.png',
      targetKind: 'file',
      role: 'image',
      sourceForm: 'wiki-embed',
      resolvedTarget: 'ghost.png',
      reason: 'no-such-file',
      resolutionMethod: 'root-relative',
    });
  });
});

describe('percent-encoded targets are assessed against the decoded document', () => {
  test('an encoded link to an existing document is exact, not missing', () => {
    const a = assessOne(
      '[Agent Memory](./Agent%20Memory.md)',
      inventory({ docs: ['notes/Agent Memory'] }),
    );
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'notes/Agent Memory',
      status: 'exact',
      reason: null,
    });
  });

  test('an encoded link to a genuinely absent document still reports missing', () => {
    const a = assessOne('[Gone](./Not%20Here.md)', inventory({ docs: ['notes/Agent Memory'] }));
    expect(a).toMatchObject({ targetKind: 'document', status: 'missing' });
  });

  test('an encoded asset link resolves to the decoded file', () => {
    const a = assessOne(
      '[Spec](./design%20spec.pdf)',
      inventory({ files: ['notes/design spec.pdf'] }),
    );
    expect(a).toMatchObject({ status: 'exact' });
  });

  test('a wiki asset embed keeps percent sequences literal', () => {
    const a = assessOne('![[100%20done.png]]', inventory({ files: ['notes/100%20done.png'] }));
    expect(a).toMatchObject({ status: 'exact' });
  });

  test('a wiki asset embed does not resolve to the decoded neighbour', () => {
    const a = assessOne('![[100%20done.png]]', inventory({ files: ['notes/100 done.png'] }));
    expect(a).toMatchObject({ status: 'missing' });
  });
});

describe('canonically equivalent spellings resolve to the existing raw name', () => {
  const NFC = 'notes/Ren\u00e9';
  const NFD = 'notes/Rene\u0301';

  test.each([
    ['NFC', 'NFD', NFC, NFD],
    ['NFD', 'NFC', NFD, NFC],
  ])(
    'an %s href to an %s document is exact and names the stored spelling',
    (_h, _d, linked, stored) => {
      const a = assessOne(`[x](/${linked}.md)`, inventory({ docs: [stored] }));
      expect(a).toMatchObject({
        targetKind: 'document',
        status: 'exact',
        resolvedTarget: stored,
        reason: null,
        fallbackTarget: null,
      });
    },
  );

  test('a file href resolves across normalization and leaf case but not ancestor case', () => {
    const stored = 'assets/Rene\u0301.PDF';
    const inv = inventory({ files: [stored] });
    expect(assessOne('[x](/assets/Ren\u00e9.pdf)', inv)).toMatchObject({
      targetKind: 'file',
      status: 'exact',
      resolvedTarget: stored,
    });
    expect(assessOne('[x](/Assets/Ren\u00e9.pdf)', inv)).toMatchObject({
      targetKind: 'file',
      status: 'missing',
      reason: 'no-such-file',
    });
  });

  test('the tolerant folder-index tier resolves through an equivalent spelling', () => {
    const resolve = createTolerantDocumentResolver(['guides/Rene\u0301/index']);
    expect(resolve('guides/Ren\u00e9')).toBe('guides/Rene\u0301/index');
  });
});

describe('file targets that exist but are excluded by ignore rules (PRD-8896)', () => {
  const excluded = inventory({ excluded: ['notes/ignored/ig.png'] });

  test('a link to an excluded file reports excluded, not no-such-file', () => {
    const a = assessOne('[d](ignored/ig.png)', excluded);
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/ignored/ig.png',
      status: 'missing',
      reason: 'excluded',
      resolutionMethod: 'source-relative',
      fallbackTarget: null,
    });
    expect(a?.occurrence.role).toBe('link');
  });

  test('an image embed of an excluded file reports excluded', () => {
    const a = assessOne('![e](ignored/ig.png)', excluded);
    expect(a).toMatchObject({ targetKind: 'file', status: 'missing', reason: 'excluded' });
    expect(a?.occurrence.role).toBe('image');
  });

  test('a wiki embed and a wiki link of an excluded file report excluded', () => {
    for (const markdown of ['![[notes/ignored/ig.png]]', '[[notes/ignored/ig.png]]']) {
      const a = assessOne(markdown, excluded);
      expect(a).toMatchObject({
        targetKind: 'file',
        resolvedTarget: 'notes/ignored/ig.png',
        status: 'missing',
        reason: 'excluded',
      });
    }
  });

  test('a wiki embed of a file the probe does not know stays no-such-file (control)', () => {
    const a = assessOne('![[notes/ignored/missing.png]]', excluded);
    expect(a).toMatchObject({ targetKind: 'file', status: 'missing', reason: 'no-such-file' });
  });

  test('a file the probe does not know stays no-such-file (control)', () => {
    const a = assessOne('[m](ignored/missing.png)', excluded);
    expect(a).toMatchObject({ targetKind: 'file', status: 'missing', reason: 'no-such-file' });
  });

  test('an inventory without the probe keeps reporting no-such-file', () => {
    const a = assessOne('[d](ignored/ig.png)', inventory());
    expect(a).toMatchObject({ targetKind: 'file', status: 'missing', reason: 'no-such-file' });
  });

  test('an extensionless link that falls through to the file plane reports excluded', () => {
    const a = assessOne(
      '[mk](ignored/Makefile)',
      inventory({ excluded: ['notes/ignored/Makefile'] }),
    );
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/ignored/Makefile',
      status: 'missing',
      reason: 'excluded',
    });
  });

  test('a Markdown link to an existing but ignored .md file reports excluded', () => {
    const a = assessOne('[d](./drafts/plan.md)', inventory({ excluded: ['notes/drafts/plan.md'] }));
    expect(a).toMatchObject({
      targetKind: 'file',
      resolvedTarget: 'notes/drafts/plan.md',
      status: 'missing',
      reason: 'excluded',
    });
  });
});
