import {
  DOCUMENT_OPEN_BYTE_LIMIT,
  type InlineAssetMediaKind,
  isDocumentOverOpenByteLimit,
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isManagedArtifactDocName,
  isMermaidDocFile,
  mediaKindForSidebarAssetExtension,
  parseLegacyTemplateDocName,
  parseManagedArtifactName,
  parseTemplateContentDocName,
  projectSkillContentDocName,
  resolveStoredPath,
  type SkillScope,
  templateContentDocName,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import type { SkillPreviewFlavor } from '@/lib/doc-hash';
import { normalizeDocNameInput } from '@/lib/doc-paths';
import { parseProjectSkillContentDocName } from '@/lib/managed-artifact-doc-name';
import { computeAncestors, hasOkPathSegment } from './file-tree-utils';

export type ResolvedNavigationTarget =
  | {
      kind: 'doc';
      target: string;
      docName: string;
    }
  | {
      kind: 'folder-index';
      target: string;
      folderPath: string;
      docName: string;
      noteKind: 'canonical-index' | 'legacy-folder-note';
    }
  | {
      kind: 'folder';
      target: string;
      folderPath: string;
    }
  | {
      kind: 'asset';
      target: string;
      assetPath: string;
      mediaKind: InlineAssetMediaKind | null;
    }
  | {
      kind: 'skill-file';
      target: string;
      scope: SkillScope;
      name: string;
      path: string;
      host?: string;
    }
  | {
      kind: 'skills';
      target: string;
    }
  | {
      kind: 'skill-preview';
      target: string;
      flavor: SkillPreviewFlavor;
      source: string;
      name: string;
      subtitle: string;
      level?: SkillScope;
      path?: string;
    }
  | {
      kind: 'large-file';
      target: string;
      docName: string;
      size: number;
      limit: number;
    }
  | {
      kind: 'missing';
      target: string;
    };

export type ResolvedContentTarget = Exclude<
  ResolvedNavigationTarget,
  { kind: 'skills' | 'skill-preview' }
>;

interface DocumentSizeMeta {
  size?: number;
}

export function normalizeTargetPath(target: string): {
  normalizedTarget: string;
  expectsFolder: boolean;
} {
  const trimmed = target.trim();
  return {
    normalizedTarget: trimmed
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/g, ''),
    expectsFolder: /\/+$/.test(trimmed),
  };
}

function extensionlessTargetPath(target: string): string {
  return normalizeDocNameInput(target).replace(/\/+$/g, '');
}

const MARKDOWN_TARGET_EXTENSION = /\.(md|mdx)$/i;

function stripMarkdownTargetExtensions(target: string): string {
  let candidate = target;
  while (MARKDOWN_TARGET_EXTENSION.test(candidate)) {
    const next = candidate.replace(MARKDOWN_TARGET_EXTENSION, '');
    if (!next) return candidate;
    candidate = next;
  }
  return candidate;
}

function canonicalNavigationTarget(target: string, pages: ReadonlySet<string>): string {
  const { normalizedTarget, expectsFolder } = normalizeTargetPath(target);
  if (expectsFolder || !MARKDOWN_TARGET_EXTENSION.test(normalizedTarget)) return target;
  const stripped = stripMarkdownTargetExtensions(normalizedTarget);
  if (resolveStoredPath(pages, normalizedTarget) && !resolveStoredPath(pages, stripped)) {
    return target;
  }
  return stripped;
}

export function deriveKnownFolderPaths(docNames: Iterable<string>): Set<string> {
  const folderPaths = new Set<string>();
  for (const docName of docNames) {
    for (const ancestor of computeAncestors(docName)) {
      folderPaths.add(ancestor);
    }
  }
  return folderPaths;
}

function slugResolve(
  normalizedTarget: string,
  pagesBySlug: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!pagesBySlug) return undefined;
  const slug = toWikiLinkSlug(normalizedTarget);
  if (!slug) return undefined;
  return pagesBySlug.get(slug);
}

function basenameResolve(
  normalizedTarget: string,
  pagesByBasename: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!pagesByBasename) return undefined;
  if (normalizedTarget.includes('/')) return undefined;
  const slug = toWikiLinkSlug(normalizedTarget);
  if (!slug) return undefined;
  return pagesByBasename.get(slug);
}

function okReadOnlyAssetPath(docName: string, docExt?: string): string {
  if (docExt) return `${docName}${docExt}`;
  const leaf = docName.split('/').pop() ?? '';
  return leaf.lastIndexOf('.') > 0 ? docName : `${docName}.md`;
}

export function okContentNavigationTarget(
  docName: string,
  options: { pages: ReadonlySet<string>; docExt?: string },
): ResolvedContentTarget | null {
  if (!hasOkPathSegment(docName)) return null;
  if (parseTemplateContentDocName(docName)) return null;
  if (resolveStoredPath(options.pages, docName)) return null;
  const assetPath = okReadOnlyAssetPath(docName, options.docExt);
  return {
    kind: 'asset',
    target: assetPath,
    assetPath,
    mediaKind: mediaKindForSidebarAssetExtension(assetPath.slice(assetPath.lastIndexOf('.') + 1)),
  };
}

export function resolveNavigationTarget(
  requestedTarget: string,
  options: {
    pages: ReadonlySet<string>;
    folderPaths?: ReadonlySet<string>;
    pagesBySlug?: ReadonlyMap<string, string>;
    pagesByBasename?: ReadonlyMap<string, string>;
  },
): ResolvedContentTarget {
  const target = canonicalNavigationTarget(requestedTarget, options.pages);
  if (isManagedArtifactDocName(target)) {
    const parsed = parseManagedArtifactName(target);
    if (parsed?.kind === 'skill' && parsed.scope === 'project') {
      const docName = projectSkillContentDocName(parsed.name);
      return { kind: 'doc', target: docName, docName };
    }
    const legacyTemplate = parseLegacyTemplateDocName(target);
    if (legacyTemplate) {
      const docName = templateContentDocName(legacyTemplate.folder, legacyTemplate.name);
      return { kind: 'doc', target: docName, docName };
    }
    return { kind: 'doc', target, docName: target };
  }
  if (parseProjectSkillContentDocName(target)) {
    return { kind: 'doc', target, docName: target };
  }
  const templateContent = parseTemplateContentDocName(target);
  if (templateContent) {
    const docName = templateContentDocName(templateContent.folder, templateContent.name);
    return { kind: 'doc', target: docName, docName };
  }
  const { normalizedTarget, expectsFolder } = normalizeTargetPath(target);
  if (!normalizedTarget) {
    return { kind: 'missing', target: normalizedTarget };
  }
  if (
    !expectsFolder &&
    (isMermaidDocFile(normalizedTarget) ||
      isExcalidrawDocFile(normalizedTarget) ||
      isEditableTextDocFile(normalizedTarget))
  ) {
    return { kind: 'doc', target: normalizedTarget, docName: normalizedTarget };
  }
  const extensionlessTarget = extensionlessTargetPath(target);

  const storedExtensionless =
    !expectsFolder && extensionlessTarget !== normalizedTarget
      ? resolveStoredPath(options.pages, extensionlessTarget)
      : null;
  if (storedExtensionless) {
    return {
      kind: 'doc',
      target: storedExtensionless,
      docName: storedExtensionless,
    };
  }

  const storedNormalized = !expectsFolder
    ? resolveStoredPath(options.pages, normalizedTarget)
    : null;
  if (storedNormalized) {
    return {
      kind: 'doc',
      target: storedNormalized,
      docName: storedNormalized,
    };
  }

  if (!expectsFolder) {
    const slugMatchDocName = slugResolve(extensionlessTarget, options.pagesBySlug);
    if (slugMatchDocName) {
      return {
        kind: 'doc',
        target: slugMatchDocName,
        docName: slugMatchDocName,
      };
    }
  }

  const storedIndex = resolveStoredPath(options.pages, `${extensionlessTarget}/index`);
  if (storedIndex) {
    const folderPath = storedIndex.slice(0, -'/index'.length);
    return {
      kind: 'folder-index',
      target: folderPath,
      folderPath,
      docName: storedIndex,
      noteKind: 'canonical-index',
    };
  }

  const leaf = extensionlessTarget.split('/').pop();
  const storedLegacy = leaf
    ? resolveStoredPath(options.pages, `${extensionlessTarget}/${leaf}`)
    : null;
  if (storedLegacy) {
    const slash = storedLegacy.lastIndexOf('/');
    const folderPath = slash === -1 ? '' : storedLegacy.slice(0, slash);
    return {
      kind: 'folder-index',
      target: folderPath,
      folderPath,
      docName: storedLegacy,
      noteKind: 'legacy-folder-note',
    };
  }

  if (!expectsFolder) {
    const basenameMatchDocName = basenameResolve(extensionlessTarget, options.pagesByBasename);
    if (basenameMatchDocName) {
      return {
        kind: 'doc',
        target: basenameMatchDocName,
        docName: basenameMatchDocName,
      };
    }
  }

  const knownFolderPaths = options.folderPaths ?? deriveKnownFolderPaths(options.pages);
  const storedFolder = resolveStoredPath(knownFolderPaths, extensionlessTarget);
  if (storedFolder) {
    return {
      kind: 'folder',
      target: storedFolder,
      folderPath: storedFolder,
    };
  }

  if (!expectsFolder) {
    const okTarget = okContentNavigationTarget(normalizedTarget, options);
    if (okTarget) return okTarget;
  }
  return {
    kind: 'missing',
    target: extensionlessTarget || normalizedTarget,
  };
}

export function downgradeFolderIndexForHashNav(
  target: ResolvedNavigationTarget,
): ResolvedNavigationTarget {
  if (target.kind !== 'folder-index') return target;
  return {
    kind: 'folder',
    target: target.folderPath,
    folderPath: target.folderPath,
  };
}

export function largeFileNavigationTarget(
  docName: string,
  size: number | null | undefined,
  limit = DOCUMENT_OPEN_BYTE_LIMIT,
): ResolvedNavigationTarget | null {
  if (typeof size !== 'number' || !isDocumentOverOpenByteLimit(size, limit)) return null;
  return {
    kind: 'large-file',
    target: docName,
    docName,
    size,
    limit,
  };
}

export function withLargeFileOpenGuard(
  target: ResolvedNavigationTarget,
  pageMeta: ReadonlyMap<string, DocumentSizeMeta>,
  limit = DOCUMENT_OPEN_BYTE_LIMIT,
): ResolvedNavigationTarget {
  if (target.kind !== 'doc' && target.kind !== 'folder-index') return target;
  return (
    largeFileNavigationTarget(target.docName, pageMeta.get(target.docName)?.size, limit) ?? target
  );
}

export function docNameForNavigationTarget(target: ResolvedNavigationTarget): string | null {
  switch (target.kind) {
    case 'doc':
    case 'folder-index':
    case 'large-file':
      return target.docName;
    case 'missing':
      return target.target;
    case 'asset':
    case 'skill-file':
    case 'skills':
    case 'skill-preview':
    case 'folder':
      return null;
  }
}
