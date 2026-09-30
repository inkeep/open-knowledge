import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getLogger } from '../logger.ts';
import { runSubprocess } from './subprocess.ts';
import type { LocalOpSubprocessLifetime } from './subprocess-lifetime.ts';
import type { AuthEvent } from './types.ts';

const execFileAsync = promisify(execFile);

async function execForStdout(
  cmd: string,
  args: string[],
  timeoutMs: number,
  lifetime?: LocalOpSubprocessLifetime,
): Promise<string> {
  const launch = () =>
    execFileAsync(cmd, args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  const { stdout } = await (lifetime ? lifetime.execFile(launch) : launch());
  return stdout;
}

const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/opt/local/bin/gh',
  '/snap/bin/gh',
  '/usr/bin/gh',
];

interface ResolveGhDeps {
  _exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  _fileExists?: (path: string) => boolean;
  _lifetime?: LocalOpSubprocessLifetime;
}

export async function resolveGhBinaryPath(deps: ResolveGhDeps = {}): Promise<string | null> {
  const exec =
    deps._exec ??
    ((cmd: string, args: string[], timeoutMs: number) =>
      execForStdout(cmd, args, timeoutMs, deps._lifetime));
  const fileExists = deps._fileExists ?? existsSync;
  const candidates = ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];
  for (const cmd of candidates) {
    if (deps._lifetime?.stopped) return null;
    try {
      await exec(cmd, ['--version'], 5000);
      if (deps._lifetime?.stopped) return null;
      return cmd;
    } catch {}
  }
  return null;
}

async function resolveGhLogin(
  ghPath: string,
  host: string,
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string> = execForStdout,
  lifetime?: LocalOpSubprocessLifetime,
): Promise<string> {
  if (lifetime?.stopped) return '';
  try {
    const out = await exec(ghPath, ['api', '--hostname', host, 'user', '--jq', '.login'], 10000);
    return out.trim();
  } catch (err) {
    if (lifetime?.stopped) return '';
    getLogger('gh-login').warn({ err }, 'post-login username lookup failed');
    return '';
  }
}

let ghPathCache: string | null | undefined;
export function createGhBinaryPathResolver(
  lifetime: LocalOpSubprocessLifetime,
): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  return () => {
    if (lifetime.stopped) return Promise.resolve(null);
    if (ghPathCache) return Promise.resolve(ghPathCache);
    pending ??= resolveGhBinaryPath({ _lifetime: lifetime }).then((path) => {
      pending = undefined;
      if (!lifetime.stopped && path !== null) ghPathCache = path;
      return lifetime.stopped ? null : path;
    });
    return pending;
  };
}

export interface RunGhDeviceLoginOptions {
  lifetime?: LocalOpSubprocessLifetime;
  host: string;
  ghPath: string;
  cwd?: string;
  timeoutMs?: number;
  verificationDeadlineMs?: number;
  onEvent: (event: AuthEvent) => void;
}

export interface RunGhDeviceLoginController {
  done: Promise<void>;
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFICATION_DEADLINE_MS = 30_000;
const CODE_RE = /one-time code:\s*([A-Za-z0-9-]+)/i;
const URL_RE = /(https?:\/\/\S+?\/login\/device)\b/i;

export function runGhDeviceLoginSubprocess(
  opts: RunGhDeviceLoginOptions,
): RunGhDeviceLoginController {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let emittedVerification = false;
  let deadlineExpired = false;
  let stderrBuf = '';

  const proc = runSubprocess({
    lifetime: opts.lifetime,
    cliArgs: [opts.ghPath],
    cwd: opts.cwd,
    trailingArgs: [
      'auth',
      'login',
      '--hostname',
      opts.host,
      '--web',
      '--git-protocol',
      'https',
      '--skip-ssh-key',
    ],
    timeoutMs,
    onLine: () => {},
    onStderr: (chunk) => {
      if (opts.lifetime?.stopped) return;
      stderrBuf += chunk.toString('utf-8');
      if (emittedVerification) return;
      const code = stderrBuf.match(CODE_RE)?.[1];
      const url = stderrBuf.match(URL_RE)?.[1];
      if (code && url) {
        emittedVerification = true;
        opts.onEvent({
          type: 'verification',
          user_code: code,
          verification_uri: url,
          expires_in: 900,
        });
      }
    },
  });

  const verificationDeadline = setTimeout(() => {
    if (emittedVerification || opts.lifetime?.stopped) return;
    deadlineExpired = true;
    opts.onEvent({
      type: 'error',
      message:
        'Could not start the browser sign-in — try updating the GitHub CLI (gh), ' +
        'or use a personal access token instead',
    });
    proc.cancel();
  }, opts.verificationDeadlineMs ?? VERIFICATION_DEADLINE_MS);
  verificationDeadline.unref?.();

  const done = proc.done.then(async (result) => {
    clearTimeout(verificationDeadline);
    if (opts.lifetime?.stopped) return;
    if (deadlineExpired) return;
    if (result.timedOut) {
      opts.onEvent({ type: 'error', message: 'gh sign-in timed out — please try again' });
      return;
    }
    if (result.cancelled) return;
    if (result.code === 0) {
      const login = await resolveGhLogin(
        opts.ghPath,
        opts.host,
        (cmd, args, timeoutMs) => execForStdout(cmd, args, timeoutMs, opts.lifetime),
        opts.lifetime,
      );
      if (opts.lifetime?.stopped) return;
      opts.onEvent({ type: 'complete', host: opts.host, login });
      return;
    }
    opts.onEvent({ type: 'error', message: 'gh sign-in failed — please try again' });
  });

  return { done, cancel: proc.cancel };
}
