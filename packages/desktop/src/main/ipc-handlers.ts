import { execFile } from 'node:child_process';
import { join, posix as pathPosix, win32 as pathWin32 } from 'node:path';
import {
  createOsProbe,
  type ExecFileLike,
  INSTALLED_AGENTS_SCHEMES,
  type InstalledAgentScheme,
  resolveCursorBinaryDefault,
  resolveCursorSpawnInvocation,
} from '@inkeep/open-knowledge-server';
import type { HandoffStatsLine, SpawnOutcome } from '../shared/ipc-channels.ts';

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const WHICH_TIMEOUT_MS = 500;
const SPAWN_TIMEOUT_MS = 2000;

interface AppInfo {
  name: string;
  path: string;
}

interface DetectProtocolDeps {
  platform: NodeJS.Platform;
  getApplicationInfoForProtocol: (url: string) => Promise<AppInfo>;
  runMacOsProbe?: (scheme: InstalledAgentScheme) => Promise<boolean>;
  runXdgMime?: (scheme: string, timeoutMs: number) => Promise<{ stdout: string; code: number }>;
  timeoutMs?: number;
}

const macOsProbeReal: (scheme: InstalledAgentScheme) => Promise<boolean> = createOsProbe(
  'darwin',
  execFile as ExecFileLike,
);

function isInstalledAgentScheme(scheme: string): scheme is InstalledAgentScheme {
  return (INSTALLED_AGENTS_SCHEMES as readonly string[]).includes(scheme);
}

function xdgMimeReal(scheme: string, timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'xdg-mime',
      ['query', 'default', `x-scheme-handler/${scheme}`],
      { timeout: timeoutMs, encoding: 'utf-8' },
      (err, stdout) => {
        if (err) {
          resolve({ stdout: '', code: typeof err.code === 'number' ? err.code : 1 });
          return;
        }
        resolve({ stdout, code: 0 });
      },
    );
  });
}

export async function detectProtocol(
  deps: DetectProtocolDeps,
  scheme: string,
): Promise<{ installed: boolean; displayName?: string }> {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    return { installed: false };
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  if (deps.platform === 'darwin' || deps.platform === 'win32') {
    try {
      const info = await Promise.race([
        deps.getApplicationInfoForProtocol(`${scheme}://`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs),
        ),
      ]);
      if (info.name && info.path) {
        return { installed: true, displayName: info.name };
      }
    } catch {}
    if (deps.platform === 'darwin' && isInstalledAgentScheme(scheme)) {
      const probe = deps.runMacOsProbe ?? macOsProbeReal;
      try {
        if (await probe(scheme)) return { installed: true };
      } catch {}
    }
    return { installed: false };
  }

  const runner = deps.runXdgMime ?? xdgMimeReal;
  try {
    const { stdout } = await runner(scheme, timeoutMs);
    const trimmed = stdout.trim();
    if (!trimmed) return { installed: false };
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

interface SpawnCursorDeps {
  resolveCursorBinary?: (timeoutMs: number) => Promise<string | null>;
  getApplicationInfoForProtocol: (url: string) => Promise<AppInfo>;
  spawn: (exec: string, args: ReadonlyArray<string>, timeoutMs: number) => Promise<SpawnOutcome>;
  platform: NodeJS.Platform;
  projectPath?: string;
  resolveTimeoutMs?: number;
  spawnTimeoutMs?: number;
}

export function validateSpawnPath(path: string, platform: NodeJS.Platform): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.includes('\0')) return false;
  if (platform === 'win32') {
    return /^([a-zA-Z]:[\\/]|\\\\)/.test(path);
  }
  return path.startsWith('/');
}

export function isPathWithinProject(
  userPath: string,
  projectPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!validateSpawnPath(userPath, platform)) return false;
  if (!validateSpawnPath(projectPath, platform)) return false;
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  try {
    const canonicalUser = p.resolve(userPath);
    const canonicalProject = p.resolve(projectPath);
    if (platform === 'win32') {
      const userRoot = p.parse(canonicalUser).root.toLowerCase();
      const projectRoot = p.parse(canonicalProject).root.toLowerCase();
      if (!userRoot || !projectRoot || userRoot !== projectRoot) return false;
    }
    if (canonicalUser === canonicalProject) return true;
    const rel = p.relative(canonicalProject, canonicalUser);
    if (rel === '' || rel === '.') return true;
    if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
    if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\'))) {
      return false;
    }
    if (platform !== 'win32' && rel.startsWith('/')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function spawnCursor(deps: SpawnCursorDeps, path: string): Promise<SpawnOutcome> {
  if (!validateSpawnPath(path, deps.platform)) {
    return { ok: false, reason: 'invalid-path' };
  }
  if (
    deps.projectPath !== undefined &&
    !isPathWithinProject(path, deps.projectPath, deps.platform)
  ) {
    return { ok: false, reason: 'invalid-path' };
  }

  const resolver = deps.resolveCursorBinary ?? resolveCursorBinaryDefault;
  let binaryPath: string | null = null;
  try {
    binaryPath = await resolver(deps.resolveTimeoutMs ?? WHICH_TIMEOUT_MS);
  } catch {
    binaryPath = null;
  }

  if (!binaryPath) {
    try {
      const info = await deps.getApplicationInfoForProtocol('cursor://');
      if (info.path) binaryPath = info.path;
    } catch {
      binaryPath = null;
    }
  }

  if (!binaryPath) {
    return { ok: false, reason: 'not-installed' };
  }

  const { exec, args } = resolveCursorSpawnInvocation(binaryPath, path, deps.platform);
  return deps.spawn(exec, args, deps.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS);
}

type ShowItemInFolderOutcome =
  | { ok: true }
  | { ok: false; reason: 'invalid-format' | 'no-project-bound' | 'out-of-project' };

interface ShowItemInFolderDeps {
  readonly platform: NodeJS.Platform;
  readonly projectPath: string | undefined;
  readonly showItemInFolder: (path: string) => void;
}

export function showItemInFolder(
  deps: ShowItemInFolderDeps,
  path: string,
): ShowItemInFolderOutcome {
  if (!validateSpawnPath(path, deps.platform)) {
    return { ok: false, reason: 'invalid-format' };
  }
  if (deps.projectPath === undefined) {
    return { ok: false, reason: 'no-project-bound' };
  }
  if (!isPathWithinProject(path, deps.projectPath, deps.platform)) {
    return { ok: false, reason: 'out-of-project' };
  }
  deps.showItemInFolder(path);
  return { ok: true };
}

type TrashItemReason = 'not-found' | 'permission-denied' | 'system-error' | 'path-escape';

type TrashItemOutcome = { ok: true } | { ok: false; reason: TrashItemReason; detail?: string };

interface TrashItemDeps {
  readonly platform: NodeJS.Platform;
  readonly projectPath: string | undefined;
  readonly realpath: (path: string) => string;
  readonly trashItem: (path: string) => Promise<void>;
}

export function extractTrashDetail(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (err instanceof Error) {
    const localized = (err as Error & { localizedDescription?: unknown }).localizedDescription;
    if (typeof localized === 'string' && localized.length > 0) return localized;
    if (err.message.length > 0) return err.message;
    return undefined;
  }
  const stringified = String(err);
  return stringified.length > 0 ? stringified : undefined;
}

function classifyTrashError(err: unknown): TrashItemReason {
  if (!(err instanceof Error)) return 'system-error';
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPERM' || code === 'EACCES') return 'permission-denied';
  if (code === 'ENOENT') return 'not-found';
  return 'system-error';
}

export async function trashItem(deps: TrashItemDeps, absPath: string): Promise<TrashItemOutcome> {
  if (!validateSpawnPath(absPath, deps.platform)) {
    return { ok: false, reason: 'path-escape', detail: 'invalid path format' };
  }
  if (deps.projectPath === undefined) {
    return { ok: false, reason: 'path-escape', detail: 'no project bound' };
  }
  let resolved: string;
  try {
    resolved = deps.realpath(absPath);
  } catch (err) {
    return { ok: false, reason: 'not-found', detail: extractTrashDetail(err) };
  }
  if (!isPathWithinProject(resolved, deps.projectPath, deps.platform)) {
    return { ok: false, reason: 'path-escape' };
  }
  try {
    await deps.trashItem(resolved);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: classifyTrashError(err),
      detail: extractTrashDetail(err),
    };
  }
}

interface RecordHandoffDeps {
  readonly homedir: () => string;
  readonly appendFile: (path: string, content: string) => Promise<void>;
  readonly mkdir?: (path: string) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export const STATS_FILE_RELATIVE_PATH = ['.ok', 'stats.jsonl'] as const;

export async function recordHandoff(
  deps: RecordHandoffDeps,
  line: HandoffStatsLine,
): Promise<void> {
  const home = deps.homedir();
  const dir = join(home, STATS_FILE_RELATIVE_PATH[0]);
  const file = join(dir, STATS_FILE_RELATIVE_PATH[1]);
  const json = `${JSON.stringify(line)}\n`;

  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    if (deps.mkdir) {
      await deps.mkdir(dir);
    }
    await deps.appendFile(file, json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[handoff] recordHandoff failed (telemetry skipped): ${reason}`);
  }
}
