/**
 * Cross-plane link-classification uniformity.
 *
 * Every authored link occurrence must have exactly ONE canonical
 * classification — `{targetKind, resolvedTarget, status, reason,
 * resolutionMethod}` — computed once against the complete inventory
 * (documents AND files) over the complete form set (wiki, inline, reference,
 * html-img), and consumed verbatim by every reporting surface.
 *
 * Each classification plane already has its own unit tests and each one passes.
 * That is precisely the gap this file closes: the planes are only ever exercised
 * in isolation, so a disagreement between them is invisible until they are
 * COMPARED over the same document and the same inventory. `link-syntax.ts` cites
 * precedent #56 and is pinned by divergence tests for *recognition*; this is the
 * equivalent pin for *classification*.
 *
 * The two planes under comparison:
 *
 * - **A — document graph** (`backlink-index.ts`): feeds Links ▸ Outgoing and the
 *   Problems rows that carry `linkTarget`.
 * - **B — local-target assessment** (`local-target-assessment.ts`): feeds
 *   Links ▸ Local files and the Problems rows that carry `localTarget`.
 *
 * The inventory below is a boundary fake, not a mock of either plane: both
 * planes run their real production classifiers over it, and the assertions check
 * what those classifiers conclude. A fake reporting the wrong membership would
 * fail these tests rather than hide a bug.
 */

import { describe, expect, test } from 'vitest';
import {
  extractMarkdownLinksFromMarkdown,
  extractWikiLinksFromMarkdown,
} from './backlink-index.ts';
import {
  assessLocalTargets,
  createTolerantDocumentResolver,
  type LocalTargetAssessment,
  type LocalTargetInventory,
} from './local-target-assessment.ts';
import {
  extractLocalTargetOccurrences,
  type LocalTargetOccurrence,
} from './local-target-occurrences.ts';

const SOURCE_DOC = 'all-link-types';

const MATRIX = [
  '---',
  'title: All link types matrix',
  'ignored_example: "[Ignored frontmatter](assets/frontmatter-missing.txt)"',
  '---',
  '',
  '# Matrix',
  '',
  '## Documents (control rows — these already agree)',
  '',
  '- [Relative Markdown document](targets/existing-page.md)',
  '- [Missing Markdown document](targets/missing-markdown.md)',
  '',
  '## Cluster 1 — wiki forms',
  '',
  '- [[targets/existing-page]]',
  '- [[targets/missing-wiki]]',
  '- ![[targets/missing-embed]]',
  '',
  '## Cluster 2 — reference-style links',
  '',
  '- [Missing reference document][missing-doc-ref]',
  '- [Tolerant case fallback][case-doc]',
  '- [Existing reference PDF][valid-pdf]',
  '- [Missing full reference][missing-spec]',
  '- [missing-spec][]',
  '- [missing-spec]',
  '',
  '## Cluster 3 — extensionless ordinary file',
  '',
  '- [Extensionless ordinary file](assets/NOTICE)',
  '- ![Existing extensionless image target](assets/NOTICE)',
  '',
  '## Files (control rows — these already agree)',
  '',
  '- [Existing text file](assets/existing.txt)',
  '- [Missing JSON file](assets/missing.json)',
  '',
  '## Cluster 4 — non-rendering contexts (must be inert everywhere)',
  '',
  'Invisible by design <!-- [HTML comment](assets/comment-missing.txt) -->',
  '',
  '<pre>[Raw pre block](assets/pre-missing.txt)</pre>',
  '',
  '```markdown',
  '[Fenced code](assets/fenced-missing.txt)',
  '[[targets/fenced-wiki-missing]]',
  '```',
  '',
  '[missing-doc-ref]: targets/missing-reference',
  '[case-doc]: targets/case-sensitive',
  '[valid-pdf]: assets/manual.pdf',
  '[missing-spec]: assets/missing-spec.pdf',
  '',
].join('\n');

const DOCUMENTS = ['all-link-types', 'targets/existing-page', 'targets/Case Sensitive'] as const;

const FILES = ['assets/NOTICE', 'assets/existing.txt', 'assets/manual.pdf'] as const;

function buildInventory(): LocalTargetInventory {
  const documents = new Set<string>(DOCUMENTS);
  const files = new Set<string>(FILES);
  const tolerant = createTolerantDocumentResolver(documents);
  return {
    hasDocument: (docName) => documents.has(docName),
    hasFile: (path) => files.has(path),
    resolveTolerantDocument: (docName) => tolerant(docName),
  };
}

function occurrenceKey(o: Pick<LocalTargetOccurrence, 'line' | 'column' | 'href'>): string {
  return `${o.line}:${o.column}:${o.href}`;
}

function planeADocumentTargets(markdown: string): Set<string> {
  const files = new Set<string>(FILES);
  const fileOracle = { hasFile: (path: string) => files.has(path) };
  const targets = new Set<string>();
  for (const edge of [
    ...extractMarkdownLinksFromMarkdown(markdown, SOURCE_DOC, 0, fileOracle),
    ...extractWikiLinksFromMarkdown(markdown, SOURCE_DOC),
  ]) {
    if (typeof edge.target === 'string' && edge.target.length > 0) targets.add(edge.target);
  }
  return targets;
}

interface Planes {
  occurrences: LocalTargetOccurrence[];
  assessmentByKey: Map<string, LocalTargetAssessment>;
  graphDocumentTargets: Set<string>;
}

function runPlanes(): Planes {
  const inventory = buildInventory();
  const occurrences = extractLocalTargetOccurrences(MATRIX);
  const assessments = assessLocalTargets(MATRIX, SOURCE_DOC, inventory);
  return {
    occurrences,
    assessmentByKey: new Map(assessments.map((a) => [occurrenceKey(a.occurrence), a])),
    graphDocumentTargets: planeADocumentTargets(MATRIX),
  };
}

function graphHasEdgeFor(href: string, graphDocumentTargets: Set<string>): boolean {
  return (
    graphDocumentTargets.has(href) ||
    graphDocumentTargets.has(href.replace(/^\//, '')) ||
    graphDocumentTargets.has(href.replace(/\.mdx?$/, ''))
  );
}

function describeOccurrence(o: LocalTargetOccurrence): string {
  return `line ${o.line} ${o.sourceForm} ${o.role} "${o.href}"`;
}

describe('link classification uniformity across the document-graph and local-target planes', () => {
  test('every recognized occurrence receives a canonical classification', () => {
    const { occurrences, assessmentByKey } = runPlanes();

    const unclassified = occurrences
      .filter((o) => !assessmentByKey.has(occurrenceKey(o)))
      .map(describeOccurrence);

    expect(unclassified).toEqual([]);
  });

  test('an occurrence is never both an existing file and a document edge', () => {
    const { occurrences, assessmentByKey, graphDocumentTargets } = runPlanes();

    const contradictions = occurrences
      .filter((o) => {
        const assessment = assessmentByKey.get(occurrenceKey(o));
        return (
          assessment?.targetKind === 'file' &&
          assessment.status === 'exact' &&
          graphHasEdgeFor(o.href, graphDocumentTargets)
        );
      })
      .map(describeOccurrence);

    expect(contradictions).toEqual([]);
  });

  test('document links are represented in the graph regardless of authored form', () => {
    const { occurrences, assessmentByKey, graphDocumentTargets } = runPlanes();

    const missingFromGraph = occurrences
      .filter((o) => {
        const assessment = assessmentByKey.get(occurrenceKey(o));
        return (
          assessment?.targetKind === 'document' &&
          o.role === 'link' &&
          !graphHasEdgeFor(o.href, graphDocumentTargets)
        );
      })
      .map(describeOccurrence);

    expect(missingFromGraph).toEqual([]);
  });

  test('both planes resolve a wiki target to the same identity from a nested source', () => {
    const nestedSource = 'notes/index';
    const markdown = '[[targets/existing-page]]\n\n![[targets/missing-embed]]\n';
    const inventory = buildInventory();

    const planeA = new Set(
      extractWikiLinksFromMarkdown(markdown, nestedSource).map((edge) => edge.target),
    );
    const planeB = assessLocalTargets(markdown, nestedSource, inventory);

    expect(planeB.map((a) => a.resolvedTarget)).toEqual([
      'targets/existing-page',
      'targets/missing-embed',
    ]);
    for (const assessment of planeB) {
      expect(planeA).toContain(assessment.resolvedTarget);
    }
  });

  test('a body with no reference definition still yields its inline document edges', () => {
    const inlineOnly =
      '# Doc\n\n[a](targets/existing-page.md)\n\n[b](targets/missing-markdown.md)\n';
    expect(planeADocumentTargets(inlineOnly)).toEqual(
      new Set(['targets/existing-page', 'targets/missing-markdown']),
    );
  });

  test('non-rendering contexts are inert in both planes', () => {
    const { occurrences, graphDocumentTargets } = runPlanes();

    const inertHrefs = [
      'assets/comment-missing.txt',
      'assets/pre-missing.txt',
      'assets/fenced-missing.txt',
    ];
    for (const href of inertHrefs) {
      expect(occurrences.map((o) => o.href)).not.toContain(href);
    }
    expect(graphDocumentTargets).not.toContain('targets/fenced-wiki-missing');
  });
});
