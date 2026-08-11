import { describe, expect, test } from 'vitest';
import {
  assessLocalTargetOccurrences,
  assessLocalTargets,
  type LocalTargetInventory,
  toForwardLinkLocalTargets,
} from './local-target-assessment.ts';
import { extractLocalTargetOccurrences } from './local-target-occurrences.ts';

/**
 * A content-scoped inventory backed by explicit membership sets — a boundary
 * fake, not a mock: assertions check the assessment the module computes FROM the
 * membership, so a fake that reported the wrong membership would fail the tests.
 */
function inventory(opts?: {
  docs?: Iterable<string>;
  files?: Iterable<string>;
  tolerant?: Record<string, string>;
}): LocalTargetInventory {
  const docs = new Set(opts?.docs ?? []);
  const files = new Set(opts?.files ?? []);
  const tolerant = opts?.tolerant;
  const base: LocalTargetInventory = {
    hasDocument: (docName) => docs.has(docName),
    hasFile: (filePath) => files.has(filePath),
  };
  if (!tolerant) return base;
  return { ...base, resolveTolerantDocument: (docName) => tolerant[docName] ?? null };
}

const SOURCE = 'notes/index';

/** Assess a single-occurrence document and return that occurrence's assessment. */
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
    // The image is a role on the occurrence, distinct from the file target kind.
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
    // A doc target is never satisfied by a same-named entry in the file inventory.
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
    // Never probes the filesystem for an out-of-scope path: the resolver refuses it.
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
    // Guards against resolving the last segment against the inventory after an escape.
    const a = assessOne('[x](../../secrets/passwd)', inventory({ files: ['secrets/passwd'] }));
    expect(a?.status).toBe('unresolvable');
  });
});

describe('repeated occurrences share existence work while each keeps its range', () => {
  test('the inventory is consulted once per distinct href, and every occurrence is assessed', () => {
    const md = 'One [a](./x.md) two [b](./x.md) three [c](./y.md).';
    let docLookups = 0;
    const inv: LocalTargetInventory = {
      hasDocument: (docName) => {
        docLookups += 1;
        return docName === 'notes/x';
      },
      hasFile: () => false,
    };
    const assessments = assessLocalTargetOccurrences(
      extractLocalTargetOccurrences(md),
      SOURCE,
      inv,
    );
    // Three occurrences, two distinct hrefs → two existence lookups.
    expect(assessments).toHaveLength(3);
    expect(docLookups).toBe(2);
    // Every occurrence retains its own exact source range.
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
    // A form the classifier refuses to answer for is a hole some surface fills
    // by guessing, which is how four planes came to disagree about one link.
    // Whether a classified form reaches a given surface is decided at the
    // projection boundary, not by declining to classify it.
    const md = 'A [[Some Page]] and an embed ![[photo.png]] plus [real](./r.md).';
    const assessments = assessLocalTargets(md, SOURCE, inventory({ docs: ['notes/r'] }));
    expect(assessments.map((a) => a.occurrence.sourceForm)).toEqual([
      'wiki-link',
      'wiki-embed',
      'markdown-inline',
    ]);
  });

  test('an extension-less wiki embed is document-shaped, not file-shaped', () => {
    // `![[Note]]` transcludes a document. The image ROLE it carries is a
    // rendering fact, not a target-kind one, so the role-based file shortcut
    // that governs markdown and HTML images must not claim it.
    const a = assessLocalTargets('![[targets/missing-embed]]', SOURCE, inventory())[0];
    expect(a).toMatchObject({
      targetKind: 'document',
      // Vault-root-relative, not source-relative — `SOURCE` is `notes/index`,
      // and the document graph resolves the same target the same way.
      resolvedTarget: 'targets/missing-embed',
      status: 'missing',
      reason: 'no-such-doc',
    });
  });

  test('an extension-bearing wiki embed stays file-shaped', () => {
    const a = assessLocalTargets(
      '![[photo.png]]',
      SOURCE,
      inventory({ files: ['notes/photo.png'] }),
    )[0];
    expect(a).toMatchObject({ targetKind: 'file', status: 'exact' });
  });

  test('a wiki target resolves entirely against the vault root, fallback included', () => {
    // The markdown file fallback is source-relative. Running it for a wiki form
    // would answer one occurrence with two resolution origins: the document
    // identity from the vault root, the file probe from the source directory.
    // An extension-less wiki target is a document by contract, so no fallback.
    const a = assessLocalTargets(
      '[[assets/NOTICE]]',
      SOURCE,
      // Source-relative would look for `notes/assets/NOTICE`; root-relative
      // finds `assets/NOTICE`. Both are present, so a wrong origin would be
      // invisible unless the assertion pins the KIND.
      inventory({ files: ['assets/NOTICE', 'notes/assets/NOTICE'] }),
    )[0];
    expect(a).toMatchObject({
      targetKind: 'document',
      resolvedTarget: 'assets/NOTICE',
      status: 'missing',
    });
  });

  test('the same extension-less href resolves per form, not per href', () => {
    // A markdown image of `assets/NOTICE` is a file; a wiki embed of it is a
    // document. Sharing one cache entry across forms would collapse them.
    const md = '![md image](assets/NOTICE)\n\n![[assets/NOTICE]]\n';
    const rows = assessLocalTargets(md, SOURCE, inventory({ files: ['assets/NOTICE'] }));
    expect(rows.map((r) => [r.occurrence.sourceForm, r.targetKind])).toEqual([
      ['markdown-inline', 'file'],
      ['wiki-embed', 'document'],
    ]);
  });
});

describe('toForwardLinkLocalTargets — Links panel Local files projection', () => {
  test('projects file and image references but excludes document graph edges and wiki forms', () => {
    const md = [
      '[report](./report.pdf)',
      '![logo](./logo.png)',
      '<img src="./pic.png">',
      '[other](./other.md)',
      '[[wiki]]',
    ].join('\n');
    const rows = toForwardLinkLocalTargets(
      assessLocalTargets(
        md,
        SOURCE,
        inventory({ docs: ['notes/other'], files: ['notes/logo.png'] }),
      ),
    );

    // Three local resources; the document link and the wiki link are not here.
    expect(rows.map((r) => r.href).sort()).toEqual(['./logo.png', './pic.png', './report.pdf']);
    expect(rows.some((r) => r.targetKind === 'document')).toBe(false);

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
    // The range travels byte-exact, so the panel can navigate to the occurrence.
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
    // Distinct occurrences keep distinct ranges — no silent collapse.
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
});
