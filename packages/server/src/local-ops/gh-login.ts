/**
 * "Sign in with gh" runner — spawns `gh auth login --hostname <host> --web` and
 * adapts gh's human-readable output into the same AuthEvent stream OpenKnowledge's
 * own device flow uses.
 *
 * Why this exists: GitHub Enterprise Server ships gh's OAuth app preregistered
 * (OpenKnowledge's is not), so gh CAN do a browser sign-in against a GHES where
 * OK's own device flow can't. When spawned without a TTY, gh degrades to a
 * device-code flow, printing to stderr:
 *
 *   ! First copy your one-time code: XXXX-XXXX
 *   Open this URL to continue in your web browser: https://<host>/login/device
 *
 * then polls the device endpoint until the user authorizes, storing the token
 * in gh's keyring — which OpenKnowledge reads via tier A. No token is handled by
 * OpenKnowledge on this path.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getLogger } from '../logger.ts';
import { runSubprocess } from './subprocess.ts';
import type { AuthEvent } from './types.ts';

const execFileAsync = promisify(execFile);

/**
 * Run a command and resolve its stdout, rejecting on non-zero exit / timeout.
 * Async so a slow or hung binary never blocks the server event loop — this
 * process also serves CRDT updates, WebSocket heartbeats, and the editor API.
 */
async function execForStdout(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout;
}

/**
 * Standard `gh` install locations. Mirrors `KNOWN_GH_PATHS` in
 * `packages/cli/src/auth/gh-detect.ts` — the packaged app's launchd PATH omits
 * Homebrew dirs, so a bare `gh` lookup misses them.
 */
const KNOWN_GH_PATHS: readonly string[] = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/opt/local/bin/gh',
  '/snap/bin/gh',
  '/usr/bin/gh',
];

interface ResolveGhDeps {
  /** Resolve stdout of `cmd args…`, reject on failure. */
  _exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
  _fileExists?: (path: string) => boolean;
}

/**
 * Resolve a working `gh` binary — bare `gh` via PATH first, then the known
 * install locations — or `null` if gh isn't installed. Verified with
 * `gh --version` so a dangling path isn't returned. Used both to decide whether
 * to offer "Sign in with gh" and to spawn gh by absolute path from the app.
 */
export async function resolveGhBinaryPath(deps: ResolveGhDeps = {}): Promise<string | null> {
  const exec = deps._exec ?? execForStdout;
  const fileExists = deps._fileExists ?? existsSync;
  const candidates = ['gh', ...KNOWN_GH_PATHS.filter(fileExists)];
  for (const cmd of candidates) {
    try {
      await exec(cmd, ['--version'], 5000);
      return cmd;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Resolve the signed-in username after gh has stored its token, by asking the
 * host's API (`gh api user`, routed to the GHES `/api/v3` by `--hostname`). gh's
 * own sign-in stderr never prints the login, so without this the completion
 * event — and the success toast built from it — has no name to show. Returns ''
 * on any failure; the client's follow-up status poll is the backstop.
 */
async function resolveGhLogin(
  ghPath: string,
  host: string,
  exec: (cmd: string, args: string[], timeoutMs: number) => Promise<string> = execForStdout,
): Promise<string> {
  try {
    const out = await exec(ghPath, ['api', '--hostname', host, 'user', '--jq', '.login'], 10000);
    return out.trim();
  } catch (err) {
    // Fallback is by design (the client's status poll backfills the name), but
    // leave a breadcrumb — a blank username in the success toast is otherwise
    // untraceable to this lookup.
    getLogger('gh-login').warn({ err }, 'post-login username lookup failed');
    return '';
  }
}

let ghPathCache: string | null | undefined;
let ghProbeInFlight: Promise<string | null> | undefined;

/**
 * Cached `resolveGhBinaryPath`. Caches only a *positive* result — gh's install
 * location doesn't move once found, so the auth-status probe reuses it. A
 * "not installed" answer is deliberately NOT cached: it's re-probed on each
 * call so a user who installs gh mid-session sees the browser path appear on
 * the next status check (i.e. by reopening the connect dialog), with no app
 * restart. The re-probe is cheap when gh is absent — a failed `gh --version`
 * spawn plus a few `existsSync` checks, no shell.
 */
export async function cachedGhBinaryPath(): Promise<string | null> {
  if (ghPathCache) return ghPathCache;
  // Dedupe concurrent first-access callers (e.g. auth/status + auth/login at
  // dialog open) onto one probe; a settled negative still re-probes next call.
  ghProbeInFlight ??= resolveGhBinaryPath().then((path) => {
    ghProbeInFlight = undefined;
    if (path !== null) ghPathCache = path;
    return path;
  });
  return ghProbeInFlight;
}

export interface RunGhDeviceLoginOptions {
  /** GitHub host to sign in to. */
  host: string;
  /** Resolved gh binary (from `resolveGhBinaryPath`). */
  ghPath: string;
  /** Wall-clock subprocess timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Deadline for gh to print the code/URL. Defaults to 30 seconds. */
  verificationDeadlineMs?: number;
  /** Called for every adapted event (`verification` / `complete` / `error`). */
  onEvent: (event: AuthEvent) => void;
}

export interface RunGhDeviceLoginController {
  /** Resolves once gh has exited and the terminal event is emitted. */
  done: Promise<void>;
  /** SIGTERM the gh child (e.g. the user cancelled). */
  cancel(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How long to wait for gh to print the one-time code + URL before giving up.
 * gh's stderr format isn't contractual — a version change, locale, or an early
 * error ("no internet", rate limit) can mean the regexes below never match.
 * Without this deadline the modal would sit in its loading state for the full
 * 10-minute wall clock with zero feedback. Normal emission is near-instant.
 */
const VERIFICATION_DEADLINE_MS = 30_000;
// gh's stderr, e.g. "! First copy your one-time code: 7625-A0A2"
const CODE_RE = /one-time code:\s*([A-Za-z0-9-]+)/i;
// "...web browser: https://<host>/login/device"
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
    // gh writes its prompts to stderr, not NDJSON on stdout.
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
    // gh never produced a recognizable code/URL — surface an actionable error
    // now instead of letting the modal spin until the 10-minute wall clock.
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
    // The deadline already emitted the terminal error and SIGTERMed gh; the
    // resulting non-zero exit must not emit a second one.
    if (deadlineExpired) return;
    if (result.code === 0) {
      // gh stored the token in its keyring; OK reads it via tier A. Resolve the
      // login now so the completion event (and its toast) name the user; the
      // client's follow-up status poll is the backstop if this lookup fails.
      const login = await resolveGhLogin(opts.ghPath, opts.host);
      opts.onEvent({ type: 'complete', host: opts.host, login });
    } else {
      // Bounded message — gh's raw stderr can carry paths; keep the wire clean.
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
