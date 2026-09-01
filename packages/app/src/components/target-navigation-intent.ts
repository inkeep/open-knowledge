import { hashFromSkillFile } from '@/lib/doc-hash';
import {
  type ResolvedContentTarget,
  type ResolvedNavigationTarget,
  resolveNavigationTarget,
} from './navigation-targets';

type TargetDisplayState = 'doc' | 'folder' | 'missing';

interface TargetNavigationIntent {
  resolvedTarget: ResolvedNavigationTarget;
  hashDocName: string;
  hash: string | null;
  displayState: TargetDisplayState;
}

function getTargetDisplayState(resolvedTarget: ResolvedContentTarget): TargetDisplayState {
  switch (resolvedTarget.kind) {
    case 'doc':
    case 'large-file':
      return 'doc';
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
            ...(resolvedTarget.host ? { host: resolvedTarget.host } : {}),
          })
        : null,
    displayState: getTargetDisplayState(resolvedTarget),
  };
}
