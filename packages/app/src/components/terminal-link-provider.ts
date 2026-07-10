/**
 * xterm `ILinkProvider` for clickable file paths in the terminal.
 *
 * `provideLinks` is a PULL model: xterm calls it only for the buffer row under
 * the mouse on hover, so validating each candidate against the filesystem
 * (`checkTargetExists`) is affordable here in a way a parse-the-whole-viewport
 * design never would be. Detection/resolution is delegated to the pure
 * `terminal-links` module; this factory owns the xterm range mapping, the
 * existence gate (snapshot fast-path → cached IPC probe), and the click route.
 *
 * Decoupled from React + the concrete `Terminal` (it takes a `readLogicalLine`
 * closure) so it unit-tests without standing up xterm.
 */

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

/** A reconstructed logical line and where it sits in the xterm buffer. */
interface LogicalLine {
  /** Full text of the logical line (wrapped continuation rows stitched in). */
  readonly text: string;
  /** 1-based buffer row where the logical line begins. */
  readonly startLine: number;
  /** Terminal width in columns — how wide each wrapped row is. */
  readonly cols: number;
}

export interface TerminalFileLinkProviderDeps {
  /** PTY cwd — relative paths in output resolve against this. */
  readonly projectPath: string;
  /**
   * Reconstruct the full logical line containing `bufferLineNumber` (xterm's
   * 1-based row) by stitching wrapped continuation rows. Reading a single row
   * would split a path longer than the terminal is wide — the reason an
   * absolute path in a narrow docked terminal never underlined.
   */
  readonly readLogicalLine: (bufferLineNumber: number) => LogicalLine | undefined;
  /** Current page-list cache snapshot (or null before first load). */
  readonly getSnapshot: () => PageListCacheSnapshot | null;
  /** Authoritative, project-contained on-disk existence probe. */
  readonly checkTargetExists: (
    kind: 'doc' | 'folder',
    relPath: string,
  ) => Promise<CheckTargetExistsResult>;
  /** Route a validated target (editor nav / OS open). */
  readonly onActivate: (target: TerminalLinkTarget) => void;
  /** Per-line detection/validation cap. Defaults to 10 (bounds probe work). */
  readonly maxLinksPerLine?: number;
}

/** Bounds the existence cache so a long session can't grow it unbounded. */
const EXISTENCE_CACHE_CAP = 1000;

export function createTerminalFileLinkProvider(deps: TerminalFileLinkProviderDeps): ILinkProvider {
  const maxLinks = deps.maxLinksPerLine ?? 10;
  // Memoize probe results per `${kind}:${relPath}`. The click path re-validates
  // via `openAsset`/nav, so a stale entry can only produce a stale underline,
  // never a wrong action.
  const existenceCache = new Map<string, boolean>();
  // Log a probe failure once — a persistently-broken `checkTargetExists` (bridge
  // crash, channel deregistration after an Electron upgrade) otherwise silently
  // stops every file-path link from underlining, indistinguishable from "no
  // matches". Fail-safe (treat errors as absent) stays; this just adds a signal.
  let warnedProbeFailure = false;
  // Same one-time diagnostic for an unexpected throw in the pure mappers
  // (resolveTerminalPath / classifyTarget) — rare, but otherwise silently
  // suppresses links with no trace.
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

  // Resolve an in-project relative path to a routable target, or null if it
  // doesn't exist. A snapshot hit skips the probe. The fallback below covers the
  // bare-directory case: `src` (no slash, no extension) classifies as an asset
  // and `checkTargetExists('doc')` requires `isFile()`, so a real directory
  // misses — retry it as a folder before giving up.
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
            // Out-of-project absolute path. Not existence-gated here: there is no
            // project-scoped probe for a path outside the project, so it links
            // optimistically and the reveal handler stats it (a missing path
            // simply shows no dialog). Clicking offers reveal-in-Finder.
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
            // The logical line may span wrapped rows; map the match's string
            // offsets back to real buffer cells (start.y/end.y can differ).
            range: terminalBufferRange(candidate.startIndex, candidate.endIndex, startLine, cols),
            activate: () => deps.onActivate(target),
          };
        }),
      )
        .then((links) => {
          const present = links.filter((link): link is ILink => link !== null);
          callback(present.length > 0 ? present : undefined);
        })
        // xterm's ILinkProvider contract requires `callback` to fire on every
        // call; a rejected chain (an unexpected throw in a candidate mapper)
        // must still resolve the hover to "no links", never leave it pending.
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
