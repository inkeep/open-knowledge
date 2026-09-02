import { hashFromSkillFile } from '@/lib/doc-hash';
import { docNameToDialogSeed } from '@/lib/doc-paths';
import { type ResolvedNavigationTarget, resolveNavigationTarget } from './navigation-targets';

type NavigableTarget = Extract<
  ResolvedNavigationTarget,
  { kind: 'doc' | 'folder-index' | 'folder' | 'large-file' }
>;
type SkillFileTarget = Extract<ResolvedNavigationTarget, { kind: 'skill-file' }>;
type MissingTarget = Extract<ResolvedNavigationTarget, { kind: 'missing' }>;

type LinkTargetIntent =
  | {
      kind: 'navigate';
      displayState: 'resolved' | 'folder';
      resolvedTarget: NavigableTarget | SkillFileTarget;
      hashDocName: string;
      hash: string | null;
    }
  | {
      kind: 'create';
      displayState: 'missing';
      resolvedTarget: MissingTarget;
      initialDir: string;
      suggestedName: string;
    };

function skillFileNavigate(
  target: SkillFileTarget,
): Extract<LinkTargetIntent, { kind: 'navigate' }> {
  return {
    kind: 'navigate',
    displayState: 'resolved',
    resolvedTarget: target,
    hashDocName: target.target,
    hash: hashFromSkillFile({ scope: target.scope, name: target.name, path: target.path }),
  };
}

export function resolveLinkTargetIntent(
  target: string,
  options: {
    pages: ReadonlySet<string>;
    folderPaths?: ReadonlySet<string>;
    pagesBySlug?: ReadonlyMap<string, string>;
    pagesByBasename?: ReadonlyMap<string, string>;
    fallbackTargets?: Iterable<string>;
    createDialogSeed?: {
      initialDir: string;
      suggestedName: string;
    };
  },
): LinkTargetIntent {
  const candidates = [target, ...(options.fallbackTargets ?? [])];
  const seen = new Set<string>();
  let missingTarget: MissingTarget | null = null;

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const resolvedTarget = resolveNavigationTarget(candidate, {
      pages: options.pages,
      folderPaths: options.folderPaths,
      pagesBySlug: options.pagesBySlug,
      pagesByBasename: options.pagesByBasename,
    });
    if (resolvedTarget.kind === 'skill-file') return skillFileNavigate(resolvedTarget);
    if (resolvedTarget.kind === 'asset') continue;
    if (resolvedTarget.kind === 'missing') {
      missingTarget ??= resolvedTarget;
      continue;
    }
    return {
      kind: 'navigate',
      displayState: resolvedTarget.kind === 'folder' ? 'folder' : 'resolved',
      resolvedTarget,
      hashDocName: resolvedTarget.target,
      hash: null,
    };
  }

  const resolvedFallback =
    missingTarget ??
    resolveNavigationTarget(target, {
      pages: options.pages,
      folderPaths: options.folderPaths,
      pagesBySlug: options.pagesBySlug,
      pagesByBasename: options.pagesByBasename,
    });
  if (resolvedFallback.kind === 'skill-file') return skillFileNavigate(resolvedFallback);
  if (resolvedFallback.kind !== 'missing' && resolvedFallback.kind !== 'asset') {
    return {
      kind: 'navigate',
      displayState: resolvedFallback.kind === 'folder' ? 'folder' : 'resolved',
      resolvedTarget: resolvedFallback,
      hashDocName: resolvedFallback.target,
      hash: null,
    };
  }
  const finalMissingTarget: MissingTarget =
    resolvedFallback.kind === 'asset' ? { kind: 'missing', target } : resolvedFallback;

  const seed = options.createDialogSeed ?? docNameToDialogSeed(finalMissingTarget.target);
  return {
    kind: 'create',
    displayState: 'missing',
    resolvedTarget: finalMissingTarget,
    initialDir: seed.initialDir,
    suggestedName: seed.suggestedName,
  };
}
