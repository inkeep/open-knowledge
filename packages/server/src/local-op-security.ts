import { lstatSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { errorResponse } from './http/error-response.ts';

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

export function isAllowedGitUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) return false;
  return ALLOWED_URL_PATTERNS.some((p) => p.test(url));
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

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

export function isSafeLocalPath(dirPath: string): boolean {
  return isPathWithinHome(dirPath, homedir());
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function hasValidLocalOpOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
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
