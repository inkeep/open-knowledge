/**
 * Security utilities for /api/local-op/* endpoints.
 *
 * All local-op endpoints enforce:
 * 1. Loopback-only — reject remote addresses
 * 2. Origin header check — only localhost/127.0.0.1/[::1]
 * 3. --dir confined to user's home dir (no path traversal)
 * 4. URL protocol allowlist (https/ssh/git/SCP; block file/javascript/ext::)
 * 5. Concurrency=1 per endpoint (see ConcurrencyGuard)
 * 6. 10-min subprocess wall-clock timeout (enforced by callers)
 * 7. Argv-array spawn — no shell interpolation (enforced by callers)
 */

import { lstatSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { errorResponse } from './http/error-response.ts';

// ─── Protocol checks ─────────────────────────────────────────────────────────

const ALLOWED_URL_PATTERNS: RegExp[] = [
  /^https?:\/\//i,
  /^ssh:\/\//i,
  /^git:\/\//i,
  /^git@[^:]+:/, // SCP-style: git@github.com:owner/repo
];

const BLOCKED_URL_PATTERNS: RegExp[] = [
  /^file:\/\//i,
  /^javascript:/i,
  /^ext::/i,
  /^data:/i,
  /^vbscript:/i,
];

/**
 * Returns true if the URL uses an allowed git-transport protocol.
 * Rejects file://, javascript:, ext::, data:, and vbscript: explicitly.
 */
export function isAllowedGitUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) return false;
  return ALLOWED_URL_PATTERNS.some((p) => p.test(url));
}

// ─── Path safety ─────────────────────────────────────────────────────────────

/** Expand a leading `~` or `~/` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Walk from `start`'s parent up to (but not including) `root` and return true
 * if any ancestor component is a symbolic link. Used to close a security gap
 * in the EPERM accept-branch of `isPathWithinHome`: `lstat` follows symlinks
 * in ancestor components and only reports `isSymbolicLink()` for the leaf, so
 * a non-symlink leaf may sit under a symlinked ancestor that redirects
 * off-home. The accept-branch runs only on the rare TCC-class denial path,
 * so the per-component cost is bounded.
 *
 * Fails closed: if any `lstat` along the chain throws, treats it as a symlink
 * (return true) — we have no basis to attest the component is safe.
 */
function ancestorChainHasSymlink(start: string, root: string): boolean {
  let cursor = dirname(start);
  while (cursor !== root && cursor !== dirname(cursor)) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(
        `[local-op-security] ancestorChainHasSymlink: lstat failed on ${cursor} (${code ?? 'unknown'}); treating as symlink (fail-closed)`,
      );
      return true;
    }
    if (stats.isSymbolicLink()) {
      console.warn(`[local-op-security] ancestorChainHasSymlink: symlink detected at ${cursor}`);
      return true;
    }
    cursor = dirname(cursor);
  }
  return false;
}

/**
 * Internal: realpath-based containment check, parameterized on `home` so tests
 * can exercise symlink scenarios without touching the developer's actual home.
 */
export function isPathWithinHome(dirPath: string, home: string): boolean {
  if (!dirPath || typeof dirPath !== 'string') return false;
  if (dirPath.includes('\0')) return false;

  let realHome: string;
  try {
    realHome = realpathSync(home);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.warn(
      `[local-op-security] realpath failed on home dir ${home} (${code ?? 'unknown'}); rejecting all paths`,
    );
    return false;
  }

  const lexicalAbs = resolve(expandTilde(dirPath));

  const suffix: string[] = [];
  let current = lexicalAbs;
  while (true) {
    let stats: ReturnType<typeof lstatSync> | null = null;
    try {
      stats = lstatSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(
          `[local-op-security] lstat error at ${current} (${code ?? 'unknown'}); rejecting`,
        );
        return false;
      }
    }

    if (stats !== null) {
      // `lstat` follows symlinks in ancestor components and only reports
      // `isSymbolicLink()` for the leaf, so even a non-symlink leaf may sit
      // under a symlinked ancestor that redirects off-home. `realpath` is
      // normally required to canonicalize. The exception is TCC-class denial
      // on macOS (Files-and-Folders gating): when `lstat` confirms the leaf
      // is not a symlink AND `realpath` returns EPERM/EACCES, the per-binary
      // realpath denial isn't a corruption signal — but the leaf attestation
      // only covers the leaf, not the ancestor chain `lstat` silently
      // followed. An explicit `ancestorChainHasSymlink` scan covers that gap
      // before the lexical path is trusted.
      let resolvedCurrent: string;
      try {
        resolvedCurrent = realpathSync(current);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (stats.isSymbolicLink()) {
          console.warn(
            `[local-op-security] realpath failed on symlink leaf at ${current} (${code ?? 'unknown'}); rejecting`,
          );
          return false;
        }
        if (code === 'EPERM' || code === 'EACCES') {
          if (ancestorChainHasSymlink(current, home)) {
            console.warn(
              `[local-op-security] EPERM accept-branch refused at ${current}: symlinked ancestor in chain; rejecting`,
            );
            return false;
          }
          console.warn(
            `[local-op-security] realpath denied on non-symlink leaf at ${current} (${code ?? 'unknown'}); trusting lexical path (TCC-class)`,
          );
          resolvedCurrent = current;
        } else {
          console.warn(
            `[local-op-security] realpath failed on non-symlink leaf at ${current} (${code ?? 'unknown'}); rejecting`,
          );
          return false;
        }
      }
      const canonical = suffix.length === 0 ? resolvedCurrent : join(resolvedCurrent, ...suffix);
      const rel = relative(realHome, canonical);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    }

    const parent = dirname(current);
    if (parent === current) return false;
    suffix.unshift(basename(current));
    current = parent;
  }
}

/**
 * Returns true if `dirPath` is within the user's home directory and contains
 * no null bytes. Resolves relative paths against cwd, expands tildes, and
 * canonicalizes via `realpath` so a pre-existing symlink anywhere on the
 * path cannot escape the gate (e.g. `~/decoy` → `/etc`, or a symlinked
 * ancestor with a real subdir below it).
 *
 * Path components that don't yet exist (the common case for clone targets)
 * cannot themselves be symlinks, so the algorithm walks up to the deepest
 * existing ancestor, canonicalizes that, and re-appends the missing suffix.
 * A broken symlink (exists as link, target gone) anywhere on the path fails
 * closed — its target is unverifiable.
 *
 * On macOS, a TCC-protected non-symlink directory may grant `lstat` but deny
 * `realpath` with EPERM/EACCES. In that specific case (lstat confirms the
 * leaf is not a symlink AND `realpath` returns EPERM/EACCES) the lexical
 * path is trusted at that component — the kernel has already attested the
 * leaf is not a redirector. Symlink leaves still fail closed on any
 * `realpath` error.
 *
 * The home-dir confinement prevents the local-op relay from being used to
 * spawn servers or clones at arbitrary system paths (e.g. /etc, /root).
 */
export function isSafeLocalPath(dirPath: string): boolean {
  return isPathWithinHome(dirPath, homedir());
}

// ─── Request security checks ─────────────────────────────────────────────────

/**
 * Returns true if the request comes from a loopback address.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Returns true if the Origin header (when present) is a loopback origin.
 * Absent Origin header is allowed (same-origin browser requests / CLI tools).
 *
 * Parses the URL and compares hostname exactly; a raw `startsWith` would
 * accept crafted origins like `http://127.0.0.1.evil.com` if DNS rebinding
 * ever lined up with the loopback socket check.
 */
export function hasValidLocalOpOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    // WHATWG URL preserves the IPv6 brackets in `hostname` (e.g. `[::1]`), so
    // the comparison set includes the bracketed form alongside the literal.
    const { hostname } = new URL(origin);
    return (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper: runs loopback + origin checks, emits an RFC 9457 403
 * problem+json response if either fails, and returns false. Returns
 * true when the request is allowed.
 *
 * The two failure modes use distinct URN tokens so operators can route on
 * the typed `problem.type`: `urn:ok:error:loopback-required` (network-level)
 * vs `urn:ok:error:invalid-origin` (header-level). `handler` is the
 * route-name tag for the `ok.api.error.count{handler}` counter.
 */
export function checkLocalOpSecurity(
  req: IncomingMessage,
  res: ServerResponse,
  options: { handler: string },
): boolean {
  if (!isLoopbackRequest(req)) {
    errorResponse(
      res,
      403,
      'urn:ok:error:loopback-required',
      'Local-op endpoints require a loopback connection.',
      { handler: options.handler },
    );
    return false;
  }
  if (!hasValidLocalOpOrigin(req)) {
    errorResponse(
      res,
      403,
      'urn:ok:error:invalid-origin',
      'Origin header is not a permitted loopback origin.',
      { handler: options.handler },
    );
    return false;
  }
  return true;
}

// ─── Concurrency guard (1 in-flight per endpoint) ────────────────────────────

/**
 * Simple per-key mutex: allows at most one in-flight request per endpoint path.
 * Returns a 429 if a second request arrives while the first is still active.
 *
 * Usage:
 *   const guard = createConcurrencyGuard();
 *   if (!guard.tryAcquire('/api/local-op/clone')) { /* already in flight *\/ }
 *   try { … } finally { guard.release('/api/local-op/clone'); }
 */
interface ConcurrencyGuard {
  tryAcquire(key: string): boolean;
  release(key: string): void;
}

export function createConcurrencyGuard(): ConcurrencyGuard {
  const inFlight = new Set<string>();
  return {
    tryAcquire(key: string): boolean {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    release(key: string): void {
      inFlight.delete(key);
    },
  };
}
