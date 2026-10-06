import {
  isManagedArtifactDocName,
  parseLegacyTemplateDocName,
  parseManagedArtifactName,
  parseTemplateContentDocName,
  projectSkillContentDocName,
  templateContentDocName,
} from '@inkeep/open-knowledge-core/constants/cc1';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core/constants/code-languages';
import {
  DOCUMENT_OPEN_BYTE_LIMIT,
  isDocumentOverOpenByteLimit,
} from '@inkeep/open-knowledge-core/constants/document-open';
import {
  type InlineAssetMediaKind,
  isExcalidrawDocFile,
  isMermaidDocFile,
  mediaKindForSidebarAssetExtension,
} from '@inkeep/open-knowledge-core/constants/upload';
import type { SkillScope } from '@inkeep/open-knowledge-core/schemas/api';
import { resolveName } from '@inkeep/open-knowledge-core/utils/target-namespace';
import { resolveWikiLinkTargetDocName } from '@inkeep/open-knowledge-core/utils/wiki-link-resolve';
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

function folderOfDocName(docName: string): string {
  return docName.slice(0, docName.lastIndexOf('/'));
}

const MARKDOWN_TARGET_EXTENSION = /\.(md|mdx)$/i;

function managedArtifactNavigationTarget(target: string, pages: ReadonlySet<string>): string {
  const { normalizedTarget, expectsFolder } = normalizeTargetPath(target);
  if (expectsFolder || !MARKDOWN_TARGET_EXTENSION.test(normalizedTarget)) return target;
  if (resolveName(pages, normalizedTarget) !== undefined) return target;
  return normalizedTarget.replace(MARKDOWN_TARGET_EXTENSION, '');
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
  if (resolveName(options.pages, docName) !== undefined) return null;
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
  const target = requestedTarget;
  const artifactTarget = managedArtifactNavigationTarget(target, options.pages);
  if (isManagedArtifactDocName(artifactTarget)) {
    const parsed = parseManagedArtifactName(artifactTarget);
    if (parsed?.kind === 'skill' && parsed.scope === 'project') {
      const docName = projectSkillContentDocName(parsed.name);
      return { kind: 'doc', target: docName, docName };
    }
    const legacyTemplate = parseLegacyTemplateDocName(artifactTarget);
    if (legacyTemplate) {
      const docName = templateContentDocName(legacyTemplate.folder, legacyTemplate.name);
      return { kind: 'doc', target: docName, docName };
    }
    return { kind: 'doc', target: artifactTarget, docName: artifactTarget };
  }
  if (parseProjectSkillContentDocName(artifactTarget)) {
    return { kind: 'doc', target: artifactTarget, docName: artifactTarget };
  }
  const templateContent = parseTemplateContentDocName(artifactTarget);
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

  const resolvedDocName = expectsFolder
    ? undefined
    : resolveWikiLinkTargetDocName(normalizedTarget, {
        pages: options.pages,
        pagesBySlug: options.pagesBySlug ?? new Map<string, string>(),
        pagesByBasename: options.pagesByBasename,
      });

  const folderTargets = expectsFolder
    ? [extensionlessTarget]
    : [normalizedTarget, extensionlessTarget];
  for (const folderTarget of folderTargets) {
    const canonicalIndexDocName = resolveName(options.pages, `${folderTarget}/index`);
    if (
      canonicalIndexDocName !== undefined &&
      (expectsFolder || resolvedDocName === canonicalIndexDocName)
    ) {
      return {
        kind: 'folder-index',
        target: folderTarget,
        folderPath: folderOfDocName(canonicalIndexDocName),
        docName: canonicalIndexDocName,
        noteKind: 'canonical-index',
      };
    }

    const leaf = folderTarget.split('/').pop();
    const legacyFolderNoteDocName = leaf
      ? resolveName(options.pages, `${folderTarget}/${leaf}`)
      : undefined;
    if (
      legacyFolderNoteDocName !== undefined &&
      (expectsFolder || resolvedDocName === legacyFolderNoteDocName)
    ) {
      return {
        kind: 'folder-index',
        target: folderTarget,
        folderPath: folderOfDocName(legacyFolderNoteDocName),
        docName: legacyFolderNoteDocName,
        noteKind: 'legacy-folder-note',
      };
    }
  }

  if (resolvedDocName !== undefined) {
    return { kind: 'doc', target: resolvedDocName, docName: resolvedDocName };
  }

  const knownFolderPaths = options.folderPaths ?? deriveKnownFolderPaths(options.pages);
  const folderPath = resolveName(knownFolderPaths, extensionlessTarget);
  if (folderPath !== undefined) {
    return {
      kind: 'folder',
      target: extensionlessTarget,
      folderPath,
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
