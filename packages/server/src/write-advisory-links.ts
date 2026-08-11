/**
 * Write-time local-target advisory: the `brokenLinks` a write/edit response
 * carries. Composes the graph-shaped byte scan (`computeBrokenOutboundLinks` —
 * document links inline + wiki, ordinary-file links) with the shared local-target
 * assessment (`assessLocalTargets`, the same predicate scoped audit runs) to add
 * the forms the graph scan cannot describe: Markdown images, HTML `img` sources,
 * and reference-style link/image targets — each carrying additive evidence
 * identical to the audit plane, so write-time and audit-time agree on one target.
 *
 * Pure over its inputs, like `computeBrokenOutboundLinks`: it validates from the
 * just-written bytes the write handler already holds, never the debounced index,
 * so a write's advisory is fresh in the same response. Report-only — a broken
 * local target never blocks the write.
 */

import type { LocalTargetDiagnosticEvidence } from '@inkeep/open-knowledge-core';
import { type BrokenOutboundLink, computeBrokenOutboundLinks } from './backlink-index.ts';
import {
  assessLocalTargets,
  buildLocalTargetEvidence,
  createTolerantDocumentResolver,
  type LocalTargetInventory,
} from './local-target-assessment.ts';

/**
 * A broken outbound link plus optional local-target evidence. The base triple
 * `{href, resolvedTo, reason}` is exactly the wire `BrokenLink`; `localTarget`
 * is present for the assessed forms (images, reference-style) the graph scan
 * omits, absent on the plain document/wiki links the triple already describes.
 */
export interface WriteAdvisoryLink extends BrokenOutboundLink {
  localTarget?: LocalTargetDiagnosticEvidence;
}

/**
 * The `brokenLinks` for a just-written document: graph-shaped links plus assessed
 * image / reference-style targets. Inline graph links retain their historical
 * per-href projection; assessed forms dedupe by repair site, so repeated uses of
 * one reference definition collapse while distinct definitions/occurrences do not.
 *
 * @param markdown      the full just-written source (frontmatter is stripped downstream)
 * @param sourceDocName the doc being written (relative hrefs resolve against its dir)
 * @param admittedDocs  every docName that currently exists (the doc-existence oracle)
 * @param fileExists    oracle for a content-root-relative file path's on-disk existence;
 *                      omit to skip file/image-existence checks (callers without a filesystem)
 */
export function computeWriteAdvisoryLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  fileExists?: (contentRootRelativePath: string) => boolean,
): WriteAdvisoryLink[] {
  const admitted = admittedDocs instanceof Set ? admittedDocs : new Set(admittedDocs);

  const inventory: LocalTargetInventory = {
    hasDocument: (docName) => admitted.has(docName),
    hasFile: (relPath) => (fileExists ? fileExists(relPath) : false),
    resolveTolerantDocument: createTolerantDocumentResolver(admitted),
  };
  const assessments = assessLocalTargets(markdown, sourceDocName, inventory);
  const inlineLinkHrefs = new Set(
    assessments
      .filter(
        ({ occurrence }) =>
          occurrence.sourceForm === 'markdown-inline' && occurrence.role === 'link',
      )
      .map(({ occurrence }) => occurrence.href),
  );
  // Graph-shaped scan: documents (inline + wiki) + ordinary-file links, deduped
  // by href, in document order. Its strict label grammar reads a badge's inner
  // image destination as a link and does not model every non-rendering block;
  // retain markdown entries only when the lossless extractor observed a real
  // inline link. Wiki entries keep their graph-owned `[[...]]` representation.
  const links: WriteAdvisoryLink[] = computeBrokenOutboundLinks(
    markdown,
    sourceDocName,
    admitted,
    fileExists,
  ).filter((link) => link.href.startsWith('[[') || inlineLinkHrefs.has(link.href));
  const graphHrefs = new Set(links.map((link) => link.href));
  const seenRepairSites = new Set<string>();

  // The assessment shares classifiers with the scan, so a form both reach (an
  // inline-markdown doc/file link) resolves to the same identity. The graph-href
  // guard keeps the scan's entry and drops that duplicate rather than
  // double-reporting, leaving the assessment to contribute only what the scan
  // cannot: images and reference-style targets.
  for (const assessment of assessments) {
    // `reason` is null exactly for an exact (resolved) target — not a finding.
    if (assessment.reason === null) continue;
    // Without a filesystem oracle, ordinary-file existence is unknowable — mirror
    // the graph scan, which skips file links rather than guess. Document and
    // path-unresolvable (root-escape) findings need no oracle and still report.
    if (!fileExists && assessment.targetKind === 'file') continue;
    const { href, role, sourceForm, range, reference } = assessment.occurrence;
    // Plain inline links already have the graph-shaped entry. Images sharing
    // that href are distinct rendered occurrences and must still be retained.
    if (role === 'link' && sourceForm === 'markdown-inline' && graphHrefs.has(href)) continue;
    // Wiki forms are classified but do not project onto the local-target wire
    // surfaces — `buildLocalTargetEvidence` owns that decision and signals it
    // with null, so reading it is the single check rather than a second form
    // predicate here that could drift from it.
    const localTarget = buildLocalTargetEvidence(assessment, assessment.reason);
    if (localTarget === null) continue;
    const repairRange = reference?.definition.repairRange ?? range;
    const repairSite = `${repairRange.start}:${repairRange.end}`;
    if (seenRepairSites.has(repairSite)) continue;
    seenRepairSites.add(repairSite);
    links.push({
      href,
      resolvedTo: assessment.resolvedTarget,
      reason: assessment.reason,
      localTarget,
    });
  }
  return links;
}
