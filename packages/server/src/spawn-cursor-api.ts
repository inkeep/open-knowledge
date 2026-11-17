/**
 * `POST /api/spawn-cursor` runs the `cursor` CLI for the web host, which cannot spawn processes;
 * the renderer then fires the deep link to seed the prompt. The wire shape follows RFC 9457 per
 * precedent #39: errors emit `application/problem+json`, success emits an empty body.
 */

import { execFile } from 'node:child_process';
import { access, constants as fsConstants, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { SpawnCursorSuccessSchema } from '@inkeep/open-knowledge-core';
import { LauncherArgumentError, windowsCmdWrap, windowsCommandCandidates } from './acp/launch.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { errorResponse } from './http/error-response.ts';
import {
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  readBoundedJsonBody,
  respondUnsupportedMediaType,
  UnsupportedMediaTypeError,
} from './http/request-validation.ts';
import { successResponse } from './http/success-response.ts';
import { getLogger } from './logger.ts';
import { type SpawnDetachedOptions, spawnDetached as spawnDetachedReal } from './spawn-detached.ts';

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
    options?: SpawnDetachedOptions,
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
    if (err instanceof UnsupportedMediaTypeError) {
      respondUnsupportedMediaType(res, HANDLER);
      return;
    }
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

  let invocation: CursorSpawnInvocation;
  try {
    invocation = resolveCursorSpawnInvocation(exec, userPath, deps.platform);
  } catch (err) {
    if (!(err instanceof LauncherArgumentError)) throw err;
    errorResponse(res, 502, 'urn:ok:error:cursor-spawn-failed', 'Cursor spawn failed.', {
      handler: HANDLER,
      detail: err.message,
    });
    return;
  }
  const spawnDetached = deps.spawnDetached ?? spawnDetachedReal;
  const outcome = await spawnDetached(
    invocation.exec,
    invocation.args,
    SPAWN_CURSOR_SPAWN_TIMEOUT_MS,
    { windowsVerbatimArguments: invocation.windowsVerbatimArguments },
  );
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
          getLogger('spawn-cursor').warn(
            { code, candidate },
            'unexpected fs.access error on bundle probe',
          );
        }
      }
    }
  }
  return findCursorCommand(timeoutMs);
}

const POSIX_PATH_LOOKUP = 'which';

type CheckFile = (candidate: string) => Promise<boolean>;

const pendingChecks = new WeakMap<CheckFile, Map<string, Promise<boolean>>>();

function checkOnce(checkFile: CheckFile, candidate: string): Promise<boolean> {
  const pending = pendingChecks.get(checkFile) ?? new Map<string, Promise<boolean>>();
  pendingChecks.set(checkFile, pending);
  const inFlight = pending.get(candidate);
  if (inFlight) return inFlight;
  const check = checkFile(candidate).finally(() => pending.delete(candidate));
  pending.set(candidate, check);
  return check;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function firstFileWithin(
  candidates: readonly string[],
  timeoutMs: number,
  checkFile: CheckFile,
): Promise<string | null> {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(null);
    }, timeoutMs);
  });
  const search = (async () => {
    for (const candidate of candidates) {
      if (expired) return null;
      if (await checkOnce(checkFile, candidate)) return candidate;
    }
    return null;
  })();
  try {
    return await Promise.race([search, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function findCursorCommand(
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  checkFile: CheckFile = isFile,
): Promise<string | null> {
  if (platform === 'win32') {
    const candidates = windowsCommandCandidates('cursor', env.PATH).filter((candidate) =>
      pathWin32.isAbsolute(candidate),
    );
    return firstFileWithin(candidates, timeoutMs, checkFile);
  }
  return new Promise((resolve) => {
    execFile(
      POSIX_PATH_LOOKUP,
      ['cursor'],
      withHiddenWindowsConsole({ timeout: timeoutMs, encoding: 'utf-8', env }),
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const first = stdout.split(/\r?\n/)[0]?.trim();
        resolve(first && first.length > 0 ? first : null);
      },
    );
  });
}

export interface CursorSpawnInvocation {
  readonly exec: string;
  readonly args: ReadonlyArray<string>;
  readonly windowsVerbatimArguments: boolean;
}

export function resolveCursorSpawnInvocation(
  resolvedPath: string,
  userPath: string,
  platform: NodeJS.Platform,
): CursorSpawnInvocation {
  if (platform === 'darwin' && /\.app\/?$/.test(resolvedPath)) {
    const bundle = resolvedPath.replace(/\/$/, '');
    return {
      exec: '/usr/bin/open',
      args: ['-a', bundle, userPath],
      windowsVerbatimArguments: false,
    };
  }
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedPath)) {
    const { cmd, args } = windowsCmdWrap(resolvedPath, [userPath]);
    return { exec: cmd, args, windowsVerbatimArguments: true };
  }
  return { exec: resolvedPath, args: [userPath], windowsVerbatimArguments: false };
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
    getLogger('spawn-cursor').warn({ err }, 'unexpected path-resolution error');
    return false;
  }
}
