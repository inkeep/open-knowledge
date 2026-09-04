import { lstatSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ALLOWED_GIT_TRANSPORTS } from '@inkeep/open-knowledge-core/skills-catalog';
import { errorResponse } from './http/error-response.ts';
import { errnoCode } from './http/handler-utils.ts';
import { buildIngressPolicy, type IngressPolicy, isPeerAdmitted } from './ingress-policy.ts';
import { getLogger } from './logger.ts';

const log = getLogger('local-op-security');

const ALLOWED_URL_PATTERNS: readonly RegExp[] = ALLOWED_GIT_TRANSPORTS;

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
      const code = errnoCode(err);
      log.warn(
        { path: cursor, code: code ?? 'unknown' },
        `ancestorChainHasSymlink: lstat failed on ${cursor} (${code ?? 'unknown'}); treating as symlink (fail-closed)`,
      );
      return true;
    }
    if (stats.isSymbolicLink()) {
      log.warn({ path: cursor }, `ancestorChainHasSymlink: symlink detected at ${cursor}`);
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
    const code = errnoCode(err);
    log.warn(
      { path: home, code: code ?? 'unknown' },
      `realpath failed on home dir ${home} (${code ?? 'unknown'}); rejecting all paths`,
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
      const code = errnoCode(err);
      if (code !== 'ENOENT') {
        log.warn(
          { path: current, code: code ?? 'unknown' },
          `lstat error at ${current} (${code ?? 'unknown'}); rejecting`,
        );
        return false;
      }
    }

    if (stats !== null) {
      let resolvedCurrent: string;
      try {
        resolvedCurrent = realpathSync(current);
      } catch (err) {
        const code = errnoCode(err);
        if (stats.isSymbolicLink()) {
          log.warn(
            { path: current, code: code ?? 'unknown' },
            `realpath failed on symlink leaf at ${current} (${code ?? 'unknown'}); rejecting`,
          );
          return false;
        }
        if (code === 'EPERM' || code === 'EACCES') {
          if (ancestorChainHasSymlink(current, home)) {
            log.warn(
              { path: current },
              `EPERM accept-branch refused at ${current}: symlinked ancestor in chain; rejecting`,
            );
            return false;
          }
          log.warn(
            { path: current, code: code ?? 'unknown' },
            `realpath denied on non-symlink leaf at ${current} (${code ?? 'unknown'}); trusting lexical path (TCC-class)`,
          );
          resolvedCurrent = current;
        } else {
          log.warn(
            { path: current, code: code ?? 'unknown' },
            `realpath failed on non-symlink leaf at ${current} (${code ?? 'unknown'}); rejecting`,
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

export function hasValidLocalOpOrigin(req: IncomingMessage, policy?: IngressPolicy): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const { hostname } = url;
    if (
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      hostname === '::1'
    ) {
      return true;
    }
    if (policy === undefined) return false;
    if (
      policy.externalOrigin !== undefined &&
      url.protocol === policy.externalOrigin.protocol &&
      normalizeOriginHost(url.host) === policy.externalOrigin.host
    ) {
      return true;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    return policy.bindLiterals.includes(bare.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeOriginHost(host: string): string {
  return host.replace(/:(443|80)$/, '').toLowerCase();
}

export function checkLocalOpSecurity(
  req: IncomingMessage,
  res: ServerResponse,
  options: { handler: string; policy?: IngressPolicy },
): boolean {
  const policy = options.policy ?? buildIngressPolicy({});
  if (!isLoopbackRequest(req) && !isPeerAdmitted(req.socket.remoteAddress, policy)) {
    errorResponse(
      res,
      403,
      'urn:ok:error:loopback-required',
      'Local-op endpoints require a loopback connection.',
      { handler: options.handler },
    );
    return false;
  }
  if (!hasValidLocalOpOrigin(req, policy)) {
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

export interface ConcurrencyGuard {
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
