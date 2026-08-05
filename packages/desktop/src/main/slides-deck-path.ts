/**
 * Decide whether a renderer-supplied deck path may be spawned against.
 *
 * Extracted from the `ok:slides:dispatch` open handler so the decision is
 * reachable from a test. The pieces it composes are individually covered
 * (`path-containment.ts` has its own suite), but their COMPOSITION is the
 * security property — and inline in `main/index.ts` it sat in the wiring, where
 * nothing could reach it without an Electron runtime.
 *
 * Trust boundary: the deck path is a renderer-supplied string over IPC.
 * Require a bound project and a well-formed absolute path, then canonicalize via
 * realpath and enforce project containment on the RESOLVED path — the same order
 * the trash / asset handlers apply. Lexical containment alone would let an
 * in-project symlink whose target is OUTSIDE the project pass, and Slidev/Vite
 * would then serve that out-of-project target over loopback; realpath collapses
 * the symlink so the escape is refused (the window's projectPath is already
 * realpath-canonical via discoverProject). A window with no project has nothing
 * to contain against, so it is refused.
 *
 * `realpath` is injected so a test can drive the throwing paths (ENOENT on a
 * broken symlink, ELOOP on a cycle) deterministically; the real filesystem is
 * the higher-fidelity default and is what the suite exercises for the escape
 * case, using a genuine symlink rather than a stubbed resolver.
 */

import { isPathWithinProject, validateSpawnPath } from './path-containment.ts';

/** Why a deck path was refused. `cause.code` carries only the OS error code —
 *  the deck path itself stays out of diagnostics (cardinality/security), and
 *  realpath's own message embeds it. */
type DeckPathRefusal = {
  readonly ok: false;
  readonly reason: 'invalid-path';
  readonly cause?: { readonly code: string | null };
};

export type DeckPathResolution =
  /** `projectRoot` rides along because admission PROVED it defined — carrying it
   *  lets the caller keep the narrowing instead of re-asserting it, which is
   *  what the discriminated spawn config needs for the project-local arm. */
  | { readonly ok: true; readonly resolvedDocPath: string; readonly projectRoot: string }
  | DeckPathRefusal;

export interface ResolveDeckPathDeps {
  /** The renderer-supplied deck path, unvalidated. */
  readonly docPath: string;
  /** The window's bound project root, already realpath-canonical. `undefined`
   *  when the window has no project — nothing to contain against. */
  readonly projectRoot: string | undefined;
  readonly platform: NodeJS.Platform;
  /** Injected so the throwing paths are drivable; production passes the real
   *  `node:fs` `realpathSync`. */
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
    // Missing deck, broken symlink, or an unreadable path — refuse rather than
    // spawn a server against a path that does not resolve.
    return {
      ok: false,
      reason: 'invalid-path',
      cause: { code: (err as NodeJS.ErrnoException | null)?.code ?? null },
    };
  }

  if (!isPathWithinProject(resolvedDocPath, projectRoot, platform)) {
    return { ok: false, reason: 'invalid-path' };
  }
  return { ok: true, resolvedDocPath, projectRoot };
}
