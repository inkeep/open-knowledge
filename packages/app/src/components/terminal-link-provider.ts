import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { CheckTargetExistsResult } from '@/lib/desktop-bridge-types';
import type { PageListCacheSnapshot } from '../editor/page-list-cache';
import {
  classifyTarget,
  detectPathCandidates,
  hasPathExtension,
  isKnownInSnapshot,
  resolveTerminalPath,
  type TerminalLinkTarget,
  terminalBufferRange,
} from './terminal-links';

interface LogicalLine {
  readonly text: string;
  readonly startLine: number;
  readonly cols: number;
}

export interface TerminalFileLinkProviderDeps {
  readonly projectPath: string;
  readonly readLogicalLine: (bufferLineNumber: number) => LogicalLine | undefined;
  readonly getSnapshot: () => PageListCacheSnapshot | null;
  readonly checkTargetExists: (
    kind: 'doc' | 'folder',
    relPath: string,
  ) => Promise<CheckTargetExistsResult>;
  readonly onActivate: (target: TerminalLinkTarget) => void;
  readonly maxLinksPerLine?: number;
}

const EXISTENCE_CACHE_CAP = 1000;

export function createTerminalFileLinkProvider(deps: TerminalFileLinkProviderDeps): ILinkProvider {
  const maxLinks = deps.maxLinksPerLine ?? 10;
  const existenceCache = new Map<string, boolean>();
  let warnedProbeFailure = false;
  let warnedComputeError = false;

  async function exists(kind: 'doc' | 'folder', relPath: string): Promise<boolean> {
    const key = `${kind}:${relPath}`;
    const cached = existenceCache.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    try {
      result = (await deps.checkTargetExists(kind, relPath)) === 'exists';
    } catch (err) {
      result = false;
      if (!warnedProbeFailure) {
        warnedProbeFailure = true;
        console.warn('[terminal] checkTargetExists probe failed; file-path links suppressed:', err);
      }
    }
    if (existenceCache.size >= EXISTENCE_CACHE_CAP) existenceCache.clear();
    existenceCache.set(key, result);
    return result;
  }

  async function routeInProject(
    relPath: string,
    trailingSlash: boolean,
    snapshot: PageListCacheSnapshot | null,
  ): Promise<TerminalLinkTarget | null> {
    const kind = classifyTarget(relPath, trailingSlash, snapshot);
    if (isKnownInSnapshot(relPath, trailingSlash, snapshot)) return { kind, relPath };
    if (kind === 'folder') {
      return (await exists('folder', relPath)) ? { kind, relPath } : null;
    }
    if (await exists('doc', relPath)) return { kind, relPath };
    if (!hasPathExtension(relPath) && (await exists('folder', relPath))) {
      return { kind: 'folder', relPath };
    }
    return null;
  }

  return {
    provideLinks(bufferLineNumber, callback) {
      const logical = deps.readLogicalLine(bufferLineNumber);
      if (!logical || logical.text.length === 0) {
        callback(undefined);
        return;
      }
      const { text, startLine, cols } = logical;

      const candidates = detectPathCandidates(text, maxLinks);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      const snapshot = deps.getSnapshot();

      void Promise.all(
        candidates.map(async (candidate): Promise<ILink | null> => {
          const resolved = resolveTerminalPath(candidate.path, deps.projectPath);
          if (resolved === null) return null;

          let target: TerminalLinkTarget;
          if (resolved.kind === 'external') {
            target = { kind: 'external', absPath: resolved.absPath };
          } else {
            const routed = await routeInProject(
              resolved.relPath,
              candidate.trailingSlash,
              snapshot,
            );
            if (routed === null) return null;
            target = routed;
          }
          return {
            text: candidate.path,
            range: terminalBufferRange(candidate.startIndex, candidate.endIndex, startLine, cols),
            activate: () => deps.onActivate(target),
          };
        }),
      )
        .then((links) => {
          const present = links.filter((link): link is ILink => link !== null);
          callback(present.length > 0 ? present : undefined);
        })
        .catch((err) => {
          if (!warnedComputeError) {
            warnedComputeError = true;
            console.warn('[terminal] link provider failed to compute links:', err);
          }
          callback(undefined);
        });
    },
  };
}
