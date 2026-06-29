
import { execFile } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { SpawnCursorSuccessSchema } from '@inkeep/open-knowledge-core';
import { errorResponse } from './http/error-response.ts';
import {
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  readBoundedJsonBody,
} from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import { spawnDetached as spawnDetachedReal } from './spawn-detached.ts';

const SPAWN_CURSOR_WHICH_TIMEOUT_MS = 500;
const SPAWN_CURSOR_SPAWN_TIMEOUT_MS = 2000;
const SPAWN_CURSOR_MAX_BODY_BYTES = 4 * 1024;
const SPAWN_CURSOR_BODY_READ_TIMEOUT_MS = 5_000;
const HANDLER = 'spawn-cursor';

function assertNeverSpawnReason(_reason: never): never {
  throw new Error(`Unhandled spawn-cursor outcome.reason: ${String(_reason)}`);
}

export type SpawnCursorOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-path' | 'not-installed' | 'timeout' | 'spawn-error' };

export interface HandleSpawnCursorDeps {
  contentDir: string;
  platform: NodeJS.Platform;
  resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  spawnDetached?: (
    exec: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<SpawnCursorOutcome>;
}

export async function handleSpawnCursor(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleSpawnCursorDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: HANDLER,
      extraHeaders: { Allow: 'POST' },
    });
    return;
  }

  let body: Buffer;
  try {
    body = await readBoundedJsonBody(req, {
      maxBytes: SPAWN_CURSOR_MAX_BODY_BYTES,
      timeoutMs: SPAWN_CURSOR_BODY_READ_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      errorResponse(res, 413, 'urn:ok:error:payload-too-large', 'Payload too large.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    if (err instanceof RequestBodyTimeoutError) {
      errorResponse(res, 408, 'urn:ok:error:request-timeout', 'Request body read timed out.', {
        handler: HANDLER,
        cause: err,
      });
      return;
    }
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to read request body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  let parsed: { path?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf-8')) as { path?: unknown };
  } catch (err) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Malformed JSON body.', {
      handler: HANDLER,
      cause: err,
    });
    return;
  }

  const userPath = typeof parsed.path === 'string' ? parsed.path : '';
  if (!userPath) {
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Missing or empty `path` field.', {
      handler: HANDLER,
    });
    return;
  }

  if (!isPathWithinDir(userPath, deps.contentDir, deps.platform)) {
    errorResponse(res, 403, 'urn:ok:error:path-escape', 'Path escapes the content directory.', {
      handler: HANDLER,
    });
    return;
  }

  const resolveCursorBinary = deps.resolveCursorBinary ?? resolveCursorBinaryDefault;
  const exec = await resolveCursorBinary(SPAWN_CURSOR_WHICH_TIMEOUT_MS);
  if (!exec) {
    errorResponse(
      res,
      422,
      'urn:ok:error:cursor-not-installed',
      'Cursor CLI not found on this machine.',
      { handler: HANDLER },
    );
    return;
  }

  const invocation = resolveCursorSpawnInvocation(exec, userPath, deps.platform);
  const spawn = deps.spawnDetached ?? spawnDetachedReal;
  const outcome = await spawn(invocation.exec, invocation.args, SPAWN_CURSOR_SPAWN_TIMEOUT_MS);
  if (outcome.ok) {
    successResponse(res, 200, SpawnCursorSuccessSchema, {}, { handler: HANDLER });
    return;
  }
  switch (outcome.reason) {
    case 'not-installed':
      errorResponse(
        res,
        422,
        'urn:ok:error:cursor-not-installed',
        'Cursor CLI not found on this machine.',
        { handler: HANDLER },
      );
      return;
    case 'timeout':
      errorResponse(
        res,
        504,
        'urn:ok:error:cursor-spawn-timeout',
        'Cursor spawn exceeded the deadline.',
        { handler: HANDLER },
      );
      return;
    case 'spawn-error':
      errorResponse(res, 502, 'urn:ok:error:cursor-spawn-failed', 'Cursor spawn failed.', {
        handler: HANDLER,
      });
      return;
    case 'invalid-path':
      errorResponse(res, 403, 'urn:ok:error:path-escape', 'Path escapes the content directory.', {
        handler: HANDLER,
      });
      return;
    default:
      return assertNeverSpawnReason(outcome.reason);
  }
}

export const CURSOR_BUNDLE_PATHS_BY_PLATFORM: Partial<
  Record<NodeJS.Platform, ReadonlyArray<(home: string) => string>>
> = {
  darwin: [
    () => '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    (home) => `${home}/Applications/Cursor.app/Contents/Resources/app/bin/cursor`,
  ],
  win32: [
    (home) => `${home}\\AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`,
    () => 'C:\\Program Files\\Cursor\\resources\\app\\bin\\cursor.cmd',
  ],
};

export async function resolveCursorBinaryDefault(timeoutMs: number): Promise<string | null> {
  const candidates = CURSOR_BUNDLE_PATHS_BY_PLATFORM[process.platform];
  if (candidates && candidates.length > 0) {
    const home = homedir();
    for (const buildPath of candidates) {
      const candidate = buildPath(home);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          console.warn(
            '[spawn-cursor] unexpected fs.access error on bundle probe:',
            code,
            candidate,
          );
        }
      }
    }
  }
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['cursor'], { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/)[0]?.trim();
      resolve(first && first.length > 0 ? first : null);
    });
  });
}

export function resolveCursorSpawnInvocation(
  resolvedPath: string,
  userPath: string,
  platform: NodeJS.Platform,
): { exec: string; args: ReadonlyArray<string> } {
  if (platform === 'darwin' && /\.app\/?$/.test(resolvedPath)) {
    const bundle = resolvedPath.replace(/\/$/, '');
    return { exec: '/usr/bin/open', args: ['-a', bundle, userPath] };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath)) {
    return {
      exec: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', resolvedPath, userPath],
    };
  }
  return { exec: resolvedPath, args: [userPath] };
}

export function isPathWithinDir(
  userPath: string,
  contentDir: string,
  platform: NodeJS.Platform,
): boolean {
  if (!userPath || typeof userPath !== 'string') return false;
  if (userPath.includes('\0')) return false;
  if (!contentDir || typeof contentDir !== 'string') return false;
  if (platform === 'win32') {
    if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(userPath)) return false;
    if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(contentDir)) return false;
  } else {
    if (!userPath.startsWith('/')) return false;
    if (!contentDir.startsWith('/')) return false;
  }
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  try {
    const canonicalUser = p.resolve(userPath);
    const canonicalDir = p.resolve(contentDir);
    if (platform === 'win32') {
      const userRoot = p.parse(canonicalUser).root.toLowerCase();
      const dirRoot = p.parse(canonicalDir).root.toLowerCase();
      if (!userRoot || !dirRoot || userRoot !== dirRoot) return false;
    }
    if (canonicalUser === canonicalDir) return true;
    const rel = p.relative(canonicalDir, canonicalUser);
    if (rel === '' || rel === '.') return true;
    if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
    if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\'))) {
      return false;
    }
    if (platform !== 'win32' && rel.startsWith('/')) return false;
    return true;
  } catch (err) {
    console.warn('[spawn-cursor] unexpected path-resolution error:', err);
    return false;
  }
}
