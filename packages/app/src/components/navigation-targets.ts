import {
  DOCUMENT_OPEN_BYTE_LIMIT,
  type InlineAssetMediaKind,
  isDocumentOverOpenByteLimit,
  isManagedArtifactDocName,
  managedArtifactDocNameFromContentTarget,
  parseGlobalSkillBundleDoc,
  parseManagedArtifactName,
  projectSkillContentDocName,
  type SkillScope,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import { normalizeDocNameInput } from '@/lib/doc-paths';
import { computeAncestors } from './file-tree-utils';

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
      // A skill bundle file (`references/**` / `scripts/**`) opened in a
      // read-only viewer. Scope-aware: read via `/api/skill-file`, NOT the
      // content-dir asset server — so a GLOBAL skill's files (which live under
      // `~/.ok/skills/`, outside the project) open instead of 404ing.
      kind: 'skill-file';
      target: string;
      scope: SkillScope;
      name: string;
      /** Skill-relative path, e.g. `references/x.md` or `scripts/run.sh`. */
      path: string;
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

interface DocumentSizeMeta {
  size?: number;
}

export function normalizeTargetPath(target: string): {
  normalizedTarget: string;
  expectsFolder: boolean;
} {
  const trimmed = target.trim();
  return {
    normalizedTarget: normalizeDocNameInput(trimmed).replace(/\/+$/g, ''),
    expectsFolder: /\/+$/.test(trimmed),
  };
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

/**
 * When `options.pagesBySlug` is provided,
 * `pages.has(target)` misses fall back to a slug-keyed lookup so a
 * dropped `.md` file carrying a lowercased slug (e.g. `casecheck123`)
 * resolves against a case-preserved cache entry (e.g. `CaseCheck123`).
 * Returns the canonical docName via the index, which becomes the target
 * of the `doc` result so downstream `hashDocName` navigation hits the
 * correct file. If `pagesBySlug` is omitted the resolver stays exact-
 * match only (backward compatible for tests constructing bare
 * `{pages: new Set(...)}` options).
 */
function slugResolve(
  normalizedTarget: string,
  pagesBySlug: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!pagesBySlug) return undefined;
  const slug = toWikiLinkSlug(normalizedTarget);
  if (!slug) return undefined;
  return pagesBySlug.get(slug);
}

/**
 * Bare-name basename fallback. When the target has no path separator,
 * look up its slug against the basename-keyed index so `[[analysis]]`
 * resolves to `andrew-data/project-x/analysis`. Alphabetical-first on
 * basename collision is baked into the index build. Targets containing
 * `/` skip this branch — a typed path that doesn't exact-match must
 * not silently rewrite to a same-leaf file in a different folder.
 */
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

export function resolveNavigationTarget(
  target: string,
  options: {
    pages: ReadonlySet<string>;
    folderPaths?: ReadonlySet<string>;
    pagesBySlug?: ReadonlyMap<string, string>;
    pagesByBasename?: ReadonlyMap<string, string>;
  },
): ResolvedNavigationTarget {
  // Managed-artifact docs (skills/templates) are real docs addressed by their
  // exact synthetic name, but they live OUTSIDE the page list — so the
  // membership checks below would mark them 'missing'. Resolve them directly as
  // a doc target so every consumer (hash nav, graph, links) treats them as real
  // instead of broken/uncreated.
  if (isManagedArtifactDocName(target)) {
    // A GLOBAL skill bundle REFERENCE graph node (`__skill__/global/<name>/
    // references/<rel>`) is not an editor doc — it lives at `~/.ok/skills/`,
    // outside the project, and opens read-only in the skill-file viewer. Resolve
    // it to a `skill-file` target so a graph click routes there instead of a
    // phantom doc tab. The node name is ext-less (content-doc style); global
    // bundle nodes are `.md` references by construction, so reconstruct the
    // on-disk path the scope-aware `/api/skill-file` endpoint reads. The global
    // SKILL doc itself (`kind: 'skill'`) keeps opening as a normal editor tab and
    // falls through below.
    const globalBundle = parseGlobalSkillBundleDoc(target);
    if (globalBundle?.kind === 'reference') {
      const path = `references/${globalBundle.rel}.md`;
      return {
        kind: 'skill-file',
        target: `global/${globalBundle.name}/${path}`,
        scope: 'global',
        name: globalBundle.name,
        path,
      };
    }
    // A project skill is a CONTENT doc (`.ok/skills/<name>/SKILL`), never the
    // synthetic `__skill__/project/<name>`. A stale deep-link / bookmark in that
    // dead form must redirect to the live content doc rather than open a phantom
    // empty tab. (Global skills + templates keep their synthetic name.)
    const parsed = parseManagedArtifactName(target);
    if (parsed?.kind === 'skill' && parsed.scope === 'project') {
      const docName = projectSkillContentDocName(parsed.name);
      return { kind: 'doc', target: docName, docName };
    }
    return { kind: 'doc', target, docName: target };
  }
  // A doc that links to a skill/template by its on-disk file path
  // (`.ok/skills/<name>/SKILL`, `<folder>/.ok/templates/<name>`) resolves to the
  // managed-artifact doc, so clicking the link opens the artifact editor instead
  // of offering to "create" a missing page.
  const artifactDocName = managedArtifactDocNameFromContentTarget(target);
  if (artifactDocName) {
    return { kind: 'doc', target: artifactDocName, docName: artifactDocName };
  }
  const { normalizedTarget, expectsFolder } = normalizeTargetPath(target);
  if (!normalizedTarget) {
    return { kind: 'missing', target: normalizedTarget };
  }

  if (!expectsFolder && options.pages.has(normalizedTarget)) {
    return {
      kind: 'doc',
      target: normalizedTarget,
      docName: normalizedTarget,
    };
  }

  if (!expectsFolder) {
    const slugMatchDocName = slugResolve(normalizedTarget, options.pagesBySlug);
    if (slugMatchDocName) {
      return {
        kind: 'doc',
        target: slugMatchDocName,
        docName: slugMatchDocName,
      };
    }
  }

  const canonicalIndexDocName = `${normalizedTarget}/index`;
  if (options.pages.has(canonicalIndexDocName)) {
    return {
      kind: 'folder-index',
      target: normalizedTarget,
      folderPath: normalizedTarget,
      docName: canonicalIndexDocName,
      noteKind: 'canonical-index',
    };
  }

  const leaf = normalizedTarget.split('/').pop();
  const legacyFolderNoteDocName = leaf ? `${normalizedTarget}/${leaf}` : null;
  if (legacyFolderNoteDocName && options.pages.has(legacyFolderNoteDocName)) {
    return {
      kind: 'folder-index',
      target: normalizedTarget,
      folderPath: normalizedTarget,
      docName: legacyFolderNoteDocName,
      noteKind: 'legacy-folder-note',
    };
  }

  if (!expectsFolder) {
    const basenameMatchDocName = basenameResolve(normalizedTarget, options.pagesByBasename);
    if (basenameMatchDocName) {
      return {
        kind: 'doc',
        target: basenameMatchDocName,
        docName: basenameMatchDocName,
      };
    }
  }

  const knownFolderPaths = options.folderPaths ?? deriveKnownFolderPaths(options.pages);
  if (knownFolderPaths.has(normalizedTarget)) {
    return {
      kind: 'folder',
      target: normalizedTarget,
      folderPath: normalizedTarget,
    };
  }

  return {
    kind: 'missing',
    target: normalizedTarget,
  };
}

/**
 * Hash-driven navigation lands on the folder overview even when an
 * `index.md` (or legacy folder note) exists. A folder-overview tab opened
 * via `openTarget({kind:'folder', ...})` writes its hash silently via
 * `history.replaceState`; if `NavigationHandler`'s effect re-fires (page
 * list populating, tab close re-assigning the hash) and the resolver
 * promotes `folder` → `folder-index`, the deps-driven re-resolution opens
 * a doc tab on top of the folder tab. Wikilinks + graph/links nav still
 * call `resolveNavigationTarget` directly and keep the auto-follow.
 */
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
    case 'folder':
      return null;
  }
}
