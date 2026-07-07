/**
 * Off-cwd server resolution — find the running OK server that serves a given
 * absolute target path, even when it is not the project at the caller's cwd.
 *
 * This is the target-aware half of the addressing guardrail: a bare doc name
 * stays cwd-scoped (resolved by the existing cwd→lock path in `preview-url.ts`),
 * but an ABSOLUTE target path is matched against every running server's
 * content directory by longest-prefix, so a loose file or a doc in a different
 * git worktree resolves to the right server instead of silently serving cwd.
 *
 * Precedence rule (stress-tested):
 *   1. realpath the target first (symlinks resolve to one canonical path).
 *   2. Among ALIVE servers, pick the one whose realpath'd contentDir CONTAINS
 *      the target, longest-prefix wins (handles nested worktrees under a main
 *      checkout, and content.dir != '.' where contentDir is a subdir of the
 *      project root).
 *   3. No live match → null (caller ensures/boots, or refuses for a bare name).
 *
 * Discovery + per-candidate inspection are injected so the rule is unit-tested
 * without a real process table or running servers. `createOffCwdResolverDeps`
 * wires the production surface.
 */

import { realpath as fsRealpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { isProcessAlive } from './process-alive.ts';
import { discoverLockDirs } from './process-scan.ts';
import { readUiLock } from './ui-lock.ts';

/** A running server discovered off-cwd, with the fields the rule needs. */
export interface OffCwdCandidate {
  /** The lock dir (`<projectDir>/.ok/local`), realpath-canonical. */
  readonly lockDir: string;
  /** The server's content directory, realpath-canonical (config-derived). */
  readonly contentDir: string;
  /** Browser-reachable origin (`http://localhost:<port>`). */
  readonly baseUrl: string;
  /** Liveness — `false` for dead-pid / unbound / cross-host locks. */
  readonly alive: boolean;
}

export interface OffCwdResolverDeps {
  /** Enumerate running-server lock dirs (≈ `discoverLockDirs`). */
  readonly discover: () => Promise<readonly string[]>;
  /** Inspect one lock dir into a candidate, or null if not a usable server. */
  readonly inspect: (lockDir: string) => Promise<OffCwdCandidate | null>;
  /** Canonicalize a path; falls back to the input on failure (missing file). */
  readonly realpath: (p: string) => Promise<string>;
}

export interface OffCwdResolution {
  /** Browser-reachable origin of the matched server. */
  readonly baseUrl: string;
  /** Ext-less doc name relative to the matched server's contentDir. */
  readonly docName: string;
}

/** True when `target` is the dir itself or a descendant of it. */
function isPathInside(target: string, dir: string): boolean {
  if (target === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return target.startsWith(prefix);
}

/** `<contentDir>` + `<target>` → ext-less, forward-slashed doc name. */
function toDocName(contentDir: string, target: string): string {
  const rel = relative(contentDir, target).split(sep).join('/');
  return rel.replace(/\.(md|mdx)$/i, '');
}

/**
 * Resolve an ABSOLUTE target path to a running server off-cwd. Returns the
 * matched server's base + the ext-less route within it, or null when no ALIVE
 * server's contentDir contains the target.
 *
 * Caller contract: only pass an absolute path. A bare doc name is ambiguous
 * across worktrees and MUST stay on the cwd-scoped path — never routed here.
 */
export async function resolveOffCwdTarget(
  absTarget: string,
  deps: OffCwdResolverDeps,
): Promise<OffCwdResolution | null> {
  const target = await deps.realpath(resolve(absTarget)).catch(() => resolve(absTarget));
  const lockDirs = await deps.discover();
  const candidates = await Promise.all(lockDirs.map((d) => deps.inspect(d).catch(() => null)));

  let best: OffCwdCandidate | null = null;
  for (const c of candidates) {
    if (c === null || !c.alive) continue;
    if (!isPathInside(target, c.contentDir)) continue;
    // Longest (most-specific) contentDir wins — nested worktree beats its parent.
    if (best === null || c.contentDir.length > best.contentDir.length) best = c;
  }
  if (best === null) return null;
  return { baseUrl: best.baseUrl, docName: toDocName(best.contentDir, target) };
}

/** `<projectDir>/.ok/local` → `<projectDir>` (the lock dir's project root). */
export function projectDirOfLockDir(lockDir: string): string {
  // getLocalDir(projectDir) === <projectDir>/.ok/local, so walk up two segments.
  return dirname(dirname(lockDir));
}

/**
 * Production deps: discover via `discoverLockDirs`; inspect each lock dir by
 * re-deriving its contentDir from `.ok/config.yml` (the lock records projectDir,
 * not contentDir), reading `ui.lock` for the port, and liveness-gating on the
 * pid. contentDir is realpath'd so the prefix match lines up with a realpath'd
 * target (both sides canonical — the symlink discipline used everywhere).
 */
export function createOffCwdResolverDeps(): OffCwdResolverDeps {
  return {
    discover: () => discoverLockDirs(),
    realpath: (p) => fsRealpath(p).catch(() => p),
    inspect: async (lockDir) => {
      const projectDir = projectDirOfLockDir(lockDir);
      let contentDir: string;
      try {
        const config = readConfigSafely({
          absPath: resolveConfigPath('project', projectDir),
          sideline: false,
          warn: () => {},
        });
        const contentRel = config.value.content?.dir ?? '.';
        const abs = resolve(projectDir, contentRel);
        contentDir = await fsRealpath(abs).catch(() => abs);
      } catch (err) {
        // A candidate whose config can't be read is dropped from discovery
        // rather than crashing the whole resolve — but log it so a genuinely
        // broken project isn't silently invisible.
        process.stderr.write(
          `[off-cwd-resolver] skipping ${lockDir} (config unreadable): ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
      }
      const lock = readUiLock(lockDir);
      const port = lock?.port ?? 0;
      const alive = lock != null && port > 0 && isProcessAlive(lock.pid);
      return { lockDir, contentDir, baseUrl: `http://localhost:${port}`, alive };
    },
  };
}
