import {
  DOCUMENT_OPEN_BYTE_LIMIT,
  type InlineAssetMediaKind,
  isDocumentOverOpenByteLimit,
  isManagedArtifactDocName,
  isMermaidDocFile,
  managedArtifactDocNameFromContentTarget,
  mediaKindForSidebarAssetExtension,
  parseManagedArtifactName,
  projectSkillContentDocName,
  type SkillScope,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import { isSkillBundleShapedPath, isSkillDocName } from '@/editor/editor-tabs';
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
      /**
       * Which same-named bundle owns this file. Several distinct-content skills
       * can share a name across host dirs; without this the read resolves to
       * whichever one a bare name lookup lands on. Omitted = by-name default.
       */
      host?: string;
    }
  | {
      // The Skills destination hub — a full-pane view with the My Skills dock +
      // internal Explore / Installed / Sources tabs. A synthetic tab kind (like
      // `skill-file`), opened via the `#/__skills__` hash; never resolved from a
      // doc name, so it does not participate in `resolveNavigationTarget`.
      kind: 'skills';
      target: string;
    }
  | {
      // A pre-install, read-only preview of an un-imported skill, opened full-pane
      // with a Manage/Import action. Synthetic (like `skills`/`skill-file`), keyed
      // by import coordinates via the `#/__skill-preview__/…` hash, never resolved
      // from a doc name — the skill is not a project doc until it is managed.
      kind: 'skill-preview';
      target: string;
      flavor: SkillPreviewFlavor;
      source: string;
      name: string;
      subtitle: string;
      level?: SkillScope;
      /** Selected bundle file within the preview (from the hash) — the FILES list
       *  + a sidebar click share one selection on a single preview tab. */
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

/**
 * Everything `resolveNavigationTarget` can yield — the content targets, minus the
 * synthetic `skills` hub (which is created only from the `#/__skills__` hash, never
 * resolved from a doc name). Consumers of resolver output narrow to this so they
 * don't carry an unreachable `skills` case.
 */
export type ResolvedContentTarget = Exclude<
  ResolvedNavigationTarget,
  { kind: 'skills' | 'skill-preview' }
>;

/**
 * `true` when the active target is skill work — the Skills hub, a read-only
 * bundle-file viewer, or a skill's SKILL.md/reference opened as a plain `doc`
 * (project skills are content docs under `.ok/skills/`; global skills use the
 * `__skill__/` managed-artifact name). Drives the sidebar's Files/Skills focus
 * and the surface a freshly-opened new tab inherits, so both read from one rule.
 */
export function isSkillFocusedTarget(target: ResolvedNavigationTarget | null): boolean {
  if (!target) return false;
  if (target.kind === 'skills' || target.kind === 'skill-file' || target.kind === 'skill-preview')
    return true;
  return (
    target.kind === 'doc' &&
    (isSkillDocName(target.docName) || isSkillBundleShapedPath(target.docName))
  );
}

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

/**
 * The on-disk file a doc-shaped `.ok` target addresses. A leaf that already
 * carries an extension (`config.yml`) is the file itself; an extension-less
 * leaf maps to its markdown file — the same `.md` the create-mode editor
 * would have lazily written, so the viewer shows exactly the bytes the old
 * write path would have touched. A leading dot alone (`.env`) is not an
 * extension.
 */
function okReadOnlyAssetPath(docName: string, docExt?: string): string {
  if (docExt) return `${docName}${docExt}`;
  const leaf = docName.split('/').pop() ?? '';
  return leaf.lastIndexOf('.') > 0 ? docName : `${docName}.md`;
}

/**
 * Read-only routing for content targets under a `.ok` path segment — the
 * doc-open guard that keeps OK-managed state out of editable and create-mode
 * editors. Raw `.ok/**` docNames are loadable as editable CRDT docs by
 * construction (persistence has no content-filter gate), so every doc-shaped
 * resolution of a `.ok` target must land on a sanctioned surface:
 *
 * - Template FILE paths (`[<folder>/].ok/templates/<name>`, single-segment
 *   leaf) rewrite to their managed-artifact doc — the validating template
 *   editor. Same rule the wiki-link resolver already applies.
 * - Page-list members (the `.ok/skills/**` carve-out) return null: they are
 *   sanctioned content docs and keep the normal doc flow (the skill editor
 *   chrome keys off the docName).
 * - Everything else resolves to the read-only text viewer on the file's
 *   on-disk path; for a nonexistent file the viewer's error pane is the
 *   non-create "missing" surface.
 *
 * Returns null for targets outside `.ok`. Pure docName-shape rule plus
 * page-list membership — consumes NO visibility state, so navigation stays
 * visibility-blind.
 */
export function okContentNavigationTarget(
  docName: string,
  options: { pages: ReadonlySet<string>; docExt?: string },
): ResolvedContentTarget | null {
  if (!hasOkPathSegment(docName)) return null;
  const artifactDocName = managedArtifactDocNameFromContentTarget(docName);
  if (artifactDocName) {
    return { kind: 'doc', target: artifactDocName, docName: artifactDocName };
  }
  if (options.pages.has(docName)) return null;
  const assetPath = okReadOnlyAssetPath(docName, options.docExt);
  // Serve asymmetry behind this target: text-shaped `.ok` files render fully
  // (the text viewer fetches `/api/asset-text`, which has no content-filter
  // gate), but binary/media kinds (image, pdf, video) fetch `/api/asset`,
  // whose `isPathIgnored` gate keeps the `.ok` floor — their preview 404s by
  // design. The `.ok` reveal is enumeration-only and never widens asset
  // serving.
  return {
    kind: 'asset',
    target: assetPath,
    assetPath,
    mediaKind: mediaKindForSidebarAssetExtension(assetPath.slice(assetPath.lastIndexOf('.') + 1)),
  };
}

export function resolveNavigationTarget(
  target: string,
  options: {
    pages: ReadonlySet<string>;
    folderPaths?: ReadonlySet<string>;
    pagesBySlug?: ReadonlyMap<string, string>;
    pagesByBasename?: ReadonlyMap<string, string>;
  },
): ResolvedContentTarget {
  // Managed-artifact docs (skills/templates) are real docs addressed by their
  // exact synthetic name, but they live OUTSIDE the page list — so the
  // membership checks below would mark them 'missing'. Resolve them directly as
  // a doc target so every consumer (hash nav, graph, links) treats them as real
  // instead of broken/uncreated.
  if (isManagedArtifactDocName(target)) {
    // A GLOBAL skill bundle `.md` REFERENCE (`__skill__/global/<name>/
    // references/<rel>`) is an EDITABLE managed-artifact live doc (the per-file
    // skill-editability feature), backed by `<home>/.ok/skills/<name>/<rel>.md`
    // via `managedArtifactAbsPath`. It falls through to the `{kind: 'doc'}`
    // return below so a graph click / tree open lands in the editor, not the
    // read-only skill-file viewer. Scripts + binary are not `__skill__/...` docs
    // (they open through the skill-file viewer directly), so only editable `.md`
    // references reach here.
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
  // A PROJECT skill's SKILL.md content doc (`.ok/skills/<name>/SKILL`) is a real
  // editable skill doc, addressed STRUCTURALLY — resolve it directly without
  // page-index membership. A freshly created/imported project skill lags the
  // index by the async `files` refetch; falling through to the pages-dependent
  // resolution below would (transiently) route it to the read-only asset viewer,
  // which strands the editor AND flips the sidebar to Files (an asset target is
  // not skill-focused, so `skillFocused` resolves false). Global skills use the
  // `__skill__/…` managed-artifact name (handled above); this is the project-scope
  // counterpart. Once the index catches up the pages branch resolves to the same
  // `{kind:'doc'}`, so this only removes the transient-strand window.
  if (parseProjectSkillContentDocName(target)) {
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
  // Standalone Mermaid docs (`assets/flow.mmd`) retain their extension in the
  // docName and live OUTSIDE the markdown `pages` set — the membership checks
  // below would mark them 'missing'. Resolve directly as a doc target (mirrors
  // the managed-artifact early return above) so tree-open / hash nav opens the
  // editable Mermaid doc editor rather than the read-only asset viewer.
  if (!expectsFolder && isMermaidDocFile(normalizedTarget)) {
    return { kind: 'doc', target: normalizedTarget, docName: normalizedTarget };
  }
  const extensionlessTarget = extensionlessTargetPath(target);

  if (!expectsFolder && options.pages.has(normalizedTarget)) {
    return {
      kind: 'doc',
      target: normalizedTarget,
      docName: normalizedTarget,
    };
  }

  if (
    !expectsFolder &&
    extensionlessTarget !== normalizedTarget &&
    options.pages.has(extensionlessTarget)
  ) {
    return {
      kind: 'doc',
      target: extensionlessTarget,
      docName: extensionlessTarget,
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

  const canonicalIndexDocName = `${extensionlessTarget}/index`;
  if (options.pages.has(canonicalIndexDocName)) {
    return {
      kind: 'folder-index',
      target: extensionlessTarget,
      folderPath: extensionlessTarget,
      docName: canonicalIndexDocName,
      noteKind: 'canonical-index',
    };
  }

  const leaf = extensionlessTarget.split('/').pop();
  const legacyFolderNoteDocName = leaf ? `${extensionlessTarget}/${leaf}` : null;
  if (legacyFolderNoteDocName && options.pages.has(legacyFolderNoteDocName)) {
    return {
      kind: 'folder-index',
      target: extensionlessTarget,
      folderPath: extensionlessTarget,
      docName: legacyFolderNoteDocName,
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
  if (knownFolderPaths.has(extensionlessTarget)) {
    return {
      kind: 'folder',
      target: extensionlessTarget,
      folderPath: extensionlessTarget,
    };
  }

  // A missing `.ok` target must not fall through to the create-mode editor —
  // route it to the read-only viewer instead (see okContentNavigationTarget).
  return (
    okContentNavigationTarget(normalizedTarget, options) ?? {
      kind: 'missing',
      target: extensionlessTarget || normalizedTarget,
    }
  );
}

/**
 * Hash-driven navigation lands on the folder overview even when an
 * `index.md` (or legacy folder note) exists. A folder-overview tab opened
 * via `openTarget({kind:'folder', ...})` writes its hash silently via
 * `history.pushState`; if `NavigationHandler`'s effect re-fires (page
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
    case 'skills':
    case 'skill-preview':
    case 'folder':
      return null;
  }
}
