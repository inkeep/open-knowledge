import {
  addDocumentFolders,
  asTargetNamespace,
  createTargetNamespace,
  type LocalTargetDiagnosticEvidence,
} from '@inkeep/open-knowledge-core';
import { type BrokenOutboundLink, computeBrokenOutboundLinks } from './backlink-index.ts';
import {
  assessLocalTargets,
  buildLocalTargetEvidence,
  createTolerantDocumentResolver,
  isWikiForm,
  type LocalTargetAssessment,
  type LocalTargetInventory,
  wikiAssetName,
} from './local-target-assessment.ts';

export interface WriteAdvisoryLink extends BrokenOutboundLink {
  localTarget?: LocalTargetDiagnosticEvidence;
}

export interface WriteAdvisoryTargets {
  fileExists: ((contentRootRelativePath: string) => boolean) | null;
  folderExists: ((folderPath: string) => boolean) | null;
  fileExcluded: ((contentRootRelativePath: string) => boolean) | null;
  resolveWikiFile: ((contentRootRelativePath: string) => string | undefined) | null;
  resolveFileByBasename: ((basename: string, sourceDocName: string) => string | undefined) | null;
}

interface VerdictSubject {
  reason: WriteAdvisoryLink['reason'];
  targetKind: LocalTargetAssessment['targetKind'] | null;
  wikiAsset: boolean;
  mayNameFile: boolean;
}

function hasVerdict(targets: WriteAdvisoryTargets, subject: VerdictSubject): boolean {
  const { reason, targetKind } = subject;
  const filesKnown = targets.fileExists !== null && targets.fileExcluded !== null;
  switch (reason) {
    case 'no-such-doc':
      return targets.folderExists !== null && (!subject.mayNameFile || filesKnown);
    case 'no-such-file':
      return filesKnown && (!subject.wikiAsset || targets.resolveWikiFile !== null);
    case 'excluded':
      return filesKnown;
    case 'unresolvable':
      return targetKind !== 'file' || targets.fileExists !== null;
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

export function computeWriteAdvisoryLinks(
  markdown: string,
  sourceDocName: string,
  admittedDocs: Iterable<string>,
  targets: WriteAdvisoryTargets,
): WriteAdvisoryLink[] {
  const fileExists = targets.fileExists ?? undefined;
  const fileExcluded = targets.fileExcluded ?? undefined;
  const { folderExists, resolveWikiFile, resolveFileByBasename } = targets;
  const documents = asTargetNamespace('document', admittedDocs);

  const folders = addDocumentFolders(createTargetNamespace('folder'), documents);
  const resolveFolder = (folderPath: string): string | undefined =>
    folders.resolve(folderPath) ?? (folderExists?.(folderPath) === true ? folderPath : undefined);
  const hasFolder = (folderPath: string): boolean => resolveFolder(folderPath) !== undefined;
  const inventory: LocalTargetInventory = {
    resolveDocument: (docName) => documents.resolve(docName),
    resolveFile: (relPath) => (fileExists?.(relPath) ? relPath : undefined),
    resolveFileByBasename,
    ...(fileExcluded ? { isExcludedFile: fileExcluded } : {}),
    ...(resolveWikiFile ? { resolveWikiFile } : {}),
    resolveTolerantDocument: createTolerantDocumentResolver(documents),
    resolveFolder,
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
  const graphLinks = computeBrokenOutboundLinks(
    markdown,
    sourceDocName,
    documents,
    fileExists,
    hasFolder,
    fileExcluded,
  ).filter(
    (link) =>
      link.sourceForm === 'jsx' || link.href.startsWith('[[') || inlineLinkHrefs.has(link.href),
  );
  const graphHrefs = new Set(graphLinks.map((link) => link.href));
  const links: WriteAdvisoryLink[] = graphLinks.filter((link) =>
    hasVerdict(targets, {
      reason: link.reason,
      targetKind: null,
      wikiAsset: false,
      mayNameFile: link.sourceForm !== 'jsx' && !link.href.startsWith('[['),
    }),
  );
  const seenRepairSites = new Set<string>();

  for (const assessment of assessments) {
    if (assessment.reason === null) continue;
    const verdict = hasVerdict(targets, {
      reason: assessment.reason,
      targetKind: assessment.targetKind,
      wikiAsset: wikiAssetName(assessment.occurrence) !== null,
      mayNameFile: !isWikiForm(assessment.occurrence.sourceForm),
    });
    if (!verdict) continue;
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
