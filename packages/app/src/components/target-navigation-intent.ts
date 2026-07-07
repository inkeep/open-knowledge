import { hashFromSkillFile } from '@/lib/doc-hash';
import { type ResolvedNavigationTarget, resolveNavigationTarget } from './navigation-targets';

type TargetDisplayState = 'doc' | 'folder' | 'missing';

interface TargetNavigationIntent {
  resolvedTarget: ResolvedNavigationTarget;
  hashDocName: string;
  /**
   * The FULL navigation hash for this target, kind-aware. For most targets this
   * is `#/<hashDocName>` (the caller may instead build it from `hashDocName`),
   * but a `skill-file` target routes to the read-only viewer via the
   * `#/__skill-file__/…` prefix — its hash cannot be expressed as a docName, so
   * a graph click must use this field rather than wrapping `hashDocName`.
   */
  hash: string | null;
  displayState: TargetDisplayState;
}

function getTargetDisplayState(resolvedTarget: ResolvedNavigationTarget): TargetDisplayState {
  switch (resolvedTarget.kind) {
    case 'doc':
    case 'large-file':
      return 'doc';
    // A skill-bundle reference resolves to a real, openable read-only viewer, so
    // it must render as a resolved node — not the dashed-red "missing" treatment
    // (which would read as a broken link even though clicking it opens the file).
    case 'skill-file':
      return 'doc';
    case 'folder':
    case 'folder-index':
      return 'folder';
    case 'missing':
    case 'asset':
      return 'missing';
  }
}

export function resolveTargetNavigationIntent(
  target: string,
  options: {
    pages: ReadonlySet<string>;
    folderPaths?: ReadonlySet<string>;
    pagesBySlug?: ReadonlyMap<string, string>;
    pagesByBasename?: ReadonlyMap<string, string>;
  },
): TargetNavigationIntent {
  const resolvedTarget = resolveNavigationTarget(target, options);

  return {
    resolvedTarget,
    hashDocName: resolvedTarget.target,
    hash:
      resolvedTarget.kind === 'skill-file'
        ? hashFromSkillFile({
            scope: resolvedTarget.scope,
            name: resolvedTarget.name,
            path: resolvedTarget.path,
          })
        : null,
    displayState: getTargetDisplayState(resolvedTarget),
  };
}
