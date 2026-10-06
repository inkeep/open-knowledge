import {
  assertNeverLinkTarget,
  asTargetNamespace,
  type BrokenLinkReason,
  classifyMarkdownHref,
  classifyWikiLinkTarget,
  type ForwardLinkLocalTarget,
  type LocalTargetDiagnosticEvidence,
  type LocalTargetSourceForm,
  resolveAssetProjectPath,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import { linkNamesDocumentFile } from './doc-extensions.ts';
import {
  extractLocalTargetOccurrences,
  type LocalTargetOccurrence,
  type OccurrenceSourceForm,
} from './local-target-occurrences.ts';

type LocalTargetKind = 'document' | 'file' | 'unknown';

type LocalTargetStatus = 'exact' | 'fallback' | 'missing' | 'unresolvable';

type LocalTargetReason = 'no-such-doc' | 'no-such-file' | 'unresolvable' | 'excluded';

type LocalTargetResolutionMethod =
  | 'source-relative'
  | 'root-relative'
  | 'tolerant'
  | 'basename'
  | 'none';

export interface LocalTargetInventory {
  resolveDocument(docName: string): string | undefined;
  resolveFile(contentRootRelativePath: string): string | undefined;
  resolveFileByBasename: ((basename: string, sourceDocName: string) => string | undefined) | null;
  resolveWikiFile?(contentRootRelativePath: string): string | undefined;
  isExcludedFile?(contentRootRelativePath: string): boolean;
  resolveTolerantDocument?(docName: string, sourceDocName: string): string | null;
  resolveFolder?(folderPath: string): string | undefined;
}

export function createTolerantDocumentResolver(
  documentNames: Iterable<string>,
): (docName: string) => string | null {
  const documents = asTargetNamespace('document', documentNames);
  const bySlug = new Map<string, string>();
  for (const docName of documents) {
    const slug = toWikiLinkSlug(docName);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, docName);
  }
  const byBasename = new Map<string, string>();
  for (const docName of [...documents].sort((a, b) => a.localeCompare(b))) {
    const leaf = docName.slice(docName.lastIndexOf('/') + 1);
    const slug = toWikiLinkSlug(leaf);
    if (slug && !byBasename.has(slug)) byBasename.set(slug, docName);
  }
  return (docName) => {
    const slug = toWikiLinkSlug(docName);
    const slugMatch = slug ? bySlug.get(slug) : undefined;
    if (slugMatch) return slugMatch;
    const canonicalIndex = documents.resolve(`${docName}/index`);
    if (canonicalIndex !== undefined) return canonicalIndex;
    const leaf = docName.slice(docName.lastIndexOf('/') + 1);
    const legacyFolderNote = documents.resolve(`${docName}/${leaf}`);
    if (legacyFolderNote !== undefined) return legacyFolderNote;
    if (!docName.includes('/') && slug) return byBasename.get(slug) ?? null;
    return null;
  };
}

export interface LocalTargetAssessment {
  occurrence: LocalTargetOccurrence;
  targetKind: LocalTargetKind;
  resolvedTarget: string | null;
  status: LocalTargetStatus;
  reason: LocalTargetReason | null;
  resolutionMethod: LocalTargetResolutionMethod;
  fallbackTarget: string | null;
}

type SharedAssessment = Omit<LocalTargetAssessment, 'occurrence'>;

function methodForHref(href: string): 'source-relative' | 'root-relative' {
  return href.trim().startsWith('/') ? 'root-relative' : 'source-relative';
}

const UNRESOLVABLE: SharedAssessment = {
  targetKind: 'unknown',
  resolvedTarget: null,
  status: 'unresolvable',
  reason: 'unresolvable',
  resolutionMethod: 'none',
  fallbackTarget: null,
};

function assessDocument(
  docName: string,
  href: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
  existingDocument: string | undefined,
): SharedAssessment {
  if (existingDocument !== undefined) {
    return {
      targetKind: 'document',
      resolvedTarget: existingDocument,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  const existingFolder = inventory.resolveFolder?.(docName);
  if (existingFolder !== undefined) {
    return {
      targetKind: 'document',
      resolvedTarget: existingFolder,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  const fallback = inventory.resolveTolerantDocument?.(docName, sourceDocName) ?? null;
  if (fallback) {
    return {
      targetKind: 'document',
      resolvedTarget: docName,
      status: 'fallback',
      reason: 'no-such-doc',
      resolutionMethod: 'tolerant',
      fallbackTarget: fallback,
    };
  }
  return {
    targetKind: 'document',
    resolvedTarget: docName,
    status: 'missing',
    reason: 'no-such-doc',
    resolutionMethod: methodForHref(href),
    fallbackTarget: null,
  };
}

function assessFile(
  assetUrl: string,
  href: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
  literal: boolean,
): SharedAssessment {
  const filePath = resolveAssetProjectPath(assetUrl, sourceDocName, { literal });
  if (filePath === null) {
    return { ...UNRESOLVABLE, targetKind: 'file' };
  }
  const existingFile = inventory.resolveFile(filePath);
  if (existingFile !== undefined) {
    return {
      targetKind: 'file',
      resolvedTarget: existingFile,
      status: 'exact',
      reason: null,
      resolutionMethod: methodForHref(href),
      fallbackTarget: null,
    };
  }
  return {
    targetKind: 'file',
    resolvedTarget: filePath,
    status: 'missing',
    reason: inventory.isExcludedFile?.(filePath) === true ? 'excluded' : 'no-such-file',
    resolutionMethod: methodForHref(href),
    fallbackTarget: null,
  };
}

function assessWikiFile(
  assetUrl: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
): SharedAssessment | null {
  const filePath = resolveAssetProjectPath(assetUrl, '', { literal: true });
  if (filePath === null) {
    return { ...UNRESOLVABLE, targetKind: 'file' };
  }
  const existingFile = inventory.resolveFile(filePath) ?? inventory.resolveWikiFile?.(filePath);
  if (existingFile !== undefined) {
    return {
      targetKind: 'file',
      resolvedTarget: existingFile,
      status: 'exact',
      reason: null,
      resolutionMethod: 'root-relative',
      fallbackTarget: null,
    };
  }
  if (!filePath.includes('/')) {
    if (inventory.resolveFileByBasename === null) return null;
    const byBasename = inventory.resolveFileByBasename(filePath, sourceDocName);
    if (byBasename !== undefined) {
      return {
        targetKind: 'file',
        resolvedTarget: byBasename,
        status: 'exact',
        reason: null,
        resolutionMethod: 'basename',
        fallbackTarget: null,
      };
    }
  }
  if (inventory.resolveTolerantDocument?.(assetUrl, sourceDocName) != null) {
    return assessDocument(
      assetUrl,
      assetUrl,
      sourceDocName,
      inventory,
      inventory.resolveDocument(assetUrl),
    );
  }
  return {
    targetKind: 'file',
    resolvedTarget: filePath,
    status: 'missing',
    reason: inventory.isExcludedFile?.(filePath) === true ? 'excluded' : 'no-such-file',
    resolutionMethod: 'root-relative',
    fallbackTarget: null,
  };
}

export function wikiFilePath(href: string): string | null {
  return resolveAssetProjectPath(href, '', { literal: true });
}

export function wikiAssetName(occurrence: LocalTargetOccurrence): string | null {
  if (!isWikiForm(occurrence.sourceForm)) return null;
  const classified = classifyWikiLinkTarget(occurrence.href, null);
  return classified?.kind === 'asset' ? classified.url : null;
}

export function isWikiForm(sourceForm: OccurrenceSourceForm): boolean {
  switch (sourceForm) {
    case 'wiki-link':
    case 'wiki-embed':
      return true;
    case 'markdown-inline':
    case 'markdown-reference':
    case 'html-img':
      return false;
    default: {
      const unreachable: never = sourceForm;
      return unreachable;
    }
  }
}

function assessHref(
  href: string,
  role: LocalTargetOccurrence['role'],
  sourceForm: OccurrenceSourceForm,
  sourceDocName: string,
  inventory: LocalTargetInventory,
): SharedAssessment | null {
  const classified = isWikiForm(sourceForm)
    ? classifyWikiLinkTarget(href, null)
    : classifyMarkdownHref(href, sourceDocName);
  if (!classified) {
    return UNRESOLVABLE;
  }
  switch (classified.kind) {
    case 'doc': {
      if (role === 'image' && !isWikiForm(sourceForm)) {
        return assessFile(href, href, sourceDocName, inventory, false);
      }
      const existingDocument = inventory.resolveDocument(classified.docName);
      if (existingDocument === undefined && !isWikiForm(sourceForm)) {
        const file = assessFile(href, href, sourceDocName, inventory, false);
        if (file.reason === 'excluded') return file;
        if (file.status === 'exact' && !linkNamesDocumentFile(href, sourceDocName)) return file;
      }
      return assessDocument(classified.docName, href, sourceDocName, inventory, existingDocument);
    }
    case 'asset':
      return isWikiForm(sourceForm)
        ? assessWikiFile(classified.url, sourceDocName, inventory)
        : assessFile(classified.url, href, sourceDocName, inventory, classified.literal);
    case 'external':
    case 'anchor':
      return null;
    default:
      return assertNeverLinkTarget(classified);
  }
}

export function assessLocalTargetOccurrences(
  occurrences: readonly LocalTargetOccurrence[],
  sourceDocName: string,
  inventory: LocalTargetInventory,
): LocalTargetAssessment[] {
  const sharedByHrefAndRole = new Map<string, SharedAssessment | null>();
  const assessments: LocalTargetAssessment[] = [];
  for (const occurrence of occurrences) {
    const cacheKey = `${occurrence.role}\0${occurrence.sourceForm}\0${occurrence.href}`;
    let shared = sharedByHrefAndRole.get(cacheKey);
    if (shared === undefined) {
      shared = assessHref(
        occurrence.href,
        occurrence.role,
        occurrence.sourceForm,
        sourceDocName,
        inventory,
      );
      sharedByHrefAndRole.set(cacheKey, shared);
    }
    if (shared === null) continue;
    assessments.push({ occurrence, ...shared });
  }
  return assessments;
}

export function assessLocalTargets(
  markdown: string,
  sourceDocName: string,
  inventory: LocalTargetInventory,
): LocalTargetAssessment[] {
  return assessLocalTargetOccurrences(
    extractLocalTargetOccurrences(markdown),
    sourceDocName,
    inventory,
  );
}

type ProjectionSubject = Pick<LocalTargetAssessment, 'occurrence' | 'targetKind'>;

function projectedSourceForm(assessment: ProjectionSubject): LocalTargetSourceForm | null {
  const form = assessment.occurrence.sourceForm;
  switch (form) {
    case 'markdown-inline':
    case 'markdown-reference':
    case 'html-img':
      return form;
    case 'wiki-link':
    case 'wiki-embed':
      return assessment.targetKind === 'file' ? form : null;
    default: {
      const unreachable: never = form;
      return unreachable;
    }
  }
}

export function isProjectableToLocalTargetSurfaces(assessment: ProjectionSubject): boolean {
  return projectedSourceForm(assessment) !== null;
}

export function buildLocalTargetEvidence(
  assessment: LocalTargetAssessment,
  reason: BrokenLinkReason,
): LocalTargetDiagnosticEvidence | null {
  const { occurrence } = assessment;
  const sourceForm = projectedSourceForm(assessment);
  if (sourceForm === null) return null;
  return {
    href: occurrence.href,
    targetKind: assessment.targetKind,
    role: occurrence.role,
    sourceForm,
    resolvedTarget: assessment.resolvedTarget,
    reason,
    resolutionMethod: assessment.resolutionMethod,
    ...(assessment.fallbackTarget === null ? {} : { fallbackTarget: assessment.fallbackTarget }),
    ...(occurrence.reference
      ? {
          definition: {
            line: occurrence.reference.definition.line,
            label: occurrence.reference.definition.label,
          },
        }
      : {}),
  };
}

export function toForwardLinkLocalTargets(
  assessments: readonly LocalTargetAssessment[],
): ForwardLinkLocalTarget[] {
  const rows: ForwardLinkLocalTarget[] = [];
  for (const assessment of assessments) {
    const { occurrence } = assessment;
    if (assessment.targetKind !== 'file' && occurrence.role !== 'image') continue;
    const sourceForm = projectedSourceForm(assessment);
    if (sourceForm === null) continue;
    rows.push({
      role: occurrence.role,
      sourceForm,
      targetKind: assessment.targetKind,
      href: occurrence.href,
      resolvedTarget: assessment.resolvedTarget,
      status: assessment.status,
      reason: assessment.reason,
      resolutionMethod: assessment.resolutionMethod,
      fallbackTarget: assessment.fallbackTarget,
      range: { start: occurrence.range.start, end: occurrence.range.end },
      line: occurrence.line,
      column: occurrence.column,
      definition: occurrence.reference
        ? {
            line: occurrence.reference.definition.line,
            label: occurrence.reference.definition.label,
          }
        : null,
    });
  }
  return rows;
}
