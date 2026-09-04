import type { LocalTargetDiagnosticEvidence } from '@inkeep/open-knowledge-core';
import { type BrokenOutboundLink, computeBrokenOutboundLinks } from './backlink-index.ts';
import {
  assessLocalTargets,
  buildLocalTargetEvidence,
  createTolerantDocumentResolver,
  type LocalTargetInventory,
} from './local-target-assessment.ts';

export interface WriteAdvisoryLink extends BrokenOutboundLink {
  localTarget?: LocalTargetDiagnosticEvidence;
}

export function computeWriteAdvisoryLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  fileExists?: (contentRootRelativePath: string) => boolean,
  folderExists?: (folderPath: string) => boolean,
): WriteAdvisoryLink[] {
  const admitted = admittedDocs instanceof Set ? admittedDocs : new Set(admittedDocs);

  const folderPaths = new Set<string>();
  for (const docName of admitted) {
    let slash = docName.indexOf('/');
    while (slash !== -1) {
      folderPaths.add(docName.slice(0, slash));
      slash = docName.indexOf('/', slash + 1);
    }
  }
  const hasFolder = (folderPath: string): boolean =>
    folderPaths.has(folderPath) || folderExists?.(folderPath) === true;
  const inventory: LocalTargetInventory = {
    hasDocument: (docName) => admitted.has(docName),
    hasFile: (relPath) => (fileExists ? fileExists(relPath) : false),
    resolveTolerantDocument: createTolerantDocumentResolver(admitted),
    hasFolder,
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
  const links: WriteAdvisoryLink[] = computeBrokenOutboundLinks(
    markdown,
    sourceDocName,
    admitted,
    fileExists,
    hasFolder,
  ).filter(
    (link) =>
      link.sourceForm === 'jsx' || link.href.startsWith('[[') || inlineLinkHrefs.has(link.href),
  );
  const graphHrefs = new Set(links.map((link) => link.href));
  const seenRepairSites = new Set<string>();

  for (const assessment of assessments) {
    if (assessment.reason === null) continue;
    if (!fileExists && assessment.targetKind === 'file') continue;
    const { href, role, sourceForm, range, reference } = assessment.occurrence;
    if (role === 'link' && sourceForm === 'markdown-inline' && graphHrefs.has(href)) continue;
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
