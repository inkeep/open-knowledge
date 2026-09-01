import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getLogger } from '../logger.ts';
import { runSubprocess } from './subprocess.ts';
import type { AuthEvent } from './types.ts';

const execFileAsync = promisify(execFile);

async function execForStdout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });
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
}

export async function resolveGhBinaryPath(deps: ResolveGhDeps = {}): Promise<string | null> {
  const exec = deps._exec ?? execForStdout;
  const fileExists = deps._fileExists ?? existsSync;
  const candidates = ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];
  for (const cmd of candidates) {
    try {
      await exec(cmd, ['--version'], 5000);
      return cmd;
    } catch {}
  }
  return null;
}

async function resolveGhLogin(
  ghPath: string,
  host: string,
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string> = execForStdout,
): Promise<string> {
  try {
    const out = await exec(ghPath, ['api', '--hostname', host, 'user', '--jq', '.login'], 10000);
    return out.trim();
  } catch (err) {
    getLogger('gh-login').warn({ err }, 'post-login username lookup failed');
    return '';
  }
}

let ghPathCache: string | null | undefined;
let ghProbeInFlight: Promise<string | null> | undefined;

export async function cachedGhBinaryPath(): Promise<string | null> {
  if (ghPathCache) return ghPathCache;
  ghProbeInFlight ??= resolveGhBinaryPath().then((path) => {
    ghProbeInFlight = undefined;
    if (path !== null) ghPathCache = path;
    return path;
  });
  return ghProbeInFlight;
}

export interface RunGhDeviceLoginOptions {
  host: string;
  ghPath: string;
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
    cliArgs: [opts.ghPath],
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
    if (emittedVerification) return;
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
    if (deadlineExpired) return;
    if (result.code === 0) {
      const login = await resolveGhLogin(opts.ghPath, opts.host);
      opts.onEvent({ type: 'complete', host: opts.host, login });
    } else {
      opts.onEvent({
        type: 'error',
        message: result.timedOut
          ? 'gh sign-in timed out — please try again'
          : 'gh sign-in failed — please try again',
      });
    }
  });

  return { done, cancel: proc.cancel };
}
