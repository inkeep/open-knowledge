import { isPathWithinProject, validateSpawnPath } from './path-containment.ts';

type DeckPathRefusal = {
  readonly ok: false;
  readonly reason: 'invalid-path';
  readonly cause?: { readonly code: string | null };
};

export type DeckPathResolution =
  | { readonly ok: true; readonly resolvedDocPath: string; readonly projectRoot: string }
  | DeckPathRefusal;

export interface ResolveDeckPathDeps {
  readonly docPath: string;
  readonly projectRoot: string | undefined;
  readonly platform: NodeJS.Platform;
  realpath(path: string): string;
}

export function resolveDeckPath(deps: ResolveDeckPathDeps): DeckPathResolution {
  const { docPath, projectRoot, platform } = deps;
  if (projectRoot === undefined || !validateSpawnPath(docPath, platform)) {
    return { ok: false, reason: 'invalid-path' };
  }

  let resolvedDocPath: string;
  try {
    resolvedDocPath = deps.realpath(docPath);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-path',
      cause: { code: (err as NodeJS.ErrnoException | null)?.code ?? null },
    };
  }

  if (
    !validateSpawnPath(resolvedDocPath, platform) ||
    !validateSpawnPath(projectRoot, platform) ||
    !isPathWithinProject(resolvedDocPath, projectRoot, platform)
  ) {
    return { ok: false, reason: 'invalid-path' };
  }
  return { ok: true, resolvedDocPath, projectRoot };
}
