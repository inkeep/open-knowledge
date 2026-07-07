/**
 * Git-clone subprocess runner — spawns `<cli> clone --json <url> <dir>` and
 * emits structured events.
 *
 * The CLI emits:
 *   {type:'progress', phase, pct}
 *   {type:'complete', dir}     ← CLI's terminal event (just the dir)
 *   {type:'error', message}
 *
 * The HTTP relay (api-extension.ts) intercepts the CLI's `complete` and
 * chains into `startServerAtDirAndGetPort` to add a `port` field before
 * forwarding to the browser. The Electron Navigator IPC path does NOT need
 * a port — main spawns a new editor window directly at `dir` — so it
 * forwards the CLI's `complete` as-is (with `dir`, no `port`).
 *
 * This runner is framing-agnostic: callers receive each parsed event
 * structurally and decide how to forward it.
 */

import { dirname, isAbsolute } from 'node:path';
import {
  assertGitAvailable,
  type GitDetected,
  GitNotAvailableError,
  GitTooOldError,
} from '../git-preflight.ts';
import { emitPreflightFailureSpan } from '../git-preflight-telemetry.ts';
import { expandTilde, isAllowedGitUrl, isSafeLocalPath } from '../local-op-security.ts';
import { getLogger } from '../logger.ts';
import { runSubprocess } from './subprocess.ts';

const log = getLogger('clone-flow');

/**
 * Variant of `CloneEvent` emitted directly by the CLI subprocess — the
 * `complete` carries `dir` instead of `port`. The HTTP relay rewrites this
 * to a port-bearing event before forwarding to browsers; the Electron IPC
 * path forwards it as-is.
 */
export type RawCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | { type: 'error'; message: string };

export interface RunCloneOptions {
  cliArgs: readonly string[];
  url: string;
  /** Tilde-expanded target directory. */
  dir: string;
  /**
   * Optional ref for `ok clone -b <branch>`. When the branch doesn't exist
   * upstream, the CLI emits a `branch-fallback` event and retries against
   * the remote default branch.
   */
  branch?: string | null;
  /** Wall-clock subprocess timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Called for every parsed event. Use the controller's `done` to know when the stream ended. */
  onEvent: (event: RawCloneEvent) => void;
}

export interface RunCloneController {
  done: Promise<void>;
  cancel(): void;
}

type CloneInputValidation = { ok: true } | { ok: false; reason: 'invalid-url' | 'invalid-dir' };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Validate clone inputs. Returns `{ok:true}` only when both pass. */
export function validateCloneInputs(url: string, dir: string): CloneInputValidation {
  if (!isAllowedGitUrl(url)) return { ok: false, reason: 'invalid-url' };
  if (!isSafeLocalPath(dir)) return { ok: false, reason: 'invalid-dir' };
  return { ok: true };
}

function asRawCloneEvent(parsed: Record<string, unknown>): RawCloneEvent | null {
  const type = parsed.type;
  if (type === 'progress') {
    if (typeof parsed.phase === 'string' && typeof parsed.pct === 'number') {
      return { type: 'progress', phase: parsed.phase, pct: parsed.pct };
    }
    return null;
  }
  if (type === 'complete') {
    if (typeof parsed.dir === 'string') {
      return { type: 'complete', dir: parsed.dir };
    }
    return null;
  }
  if (type === 'branch-fallback') {
    if (typeof parsed.branch === 'string' && parsed.branch.length > 0) {
      return { type: 'branch-fallback', branch: parsed.branch };
    }
    return null;
  }
  if (type === 'error') {
    return {
      type: 'error',
      message: typeof parsed.message === 'string' ? parsed.message : 'Unknown error',
    };
  }
  return null;
}

/**
 * Spawn `ok clone --json <url> <expanded-dir>` and stream events to
 * `onEvent`. Resolves once the subprocess exits.
 *
 * Note: the caller is responsible for any post-clone follow-up. The HTTP
 * relay rewrites the `complete` event into a port-bearing one (after
 * starting the cloned project's server); the Electron Navigator IPC path
 * leaves the `complete` as-is and lets main spawn a new editor window.
 */
export function runCloneSubprocess(opts: RunCloneOptions): RunCloneController {
  const targetDir = expandTilde(opts.dir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Verify git is usable BEFORE spawning `<cli> clone` — whose internal
  // `git clone` would otherwise surface a raw clone error. Any failure is
  // surfaced as an error EVENT with a no-op controller — never a sync throw:
  // both consumers (Electron IPC `handleCloneStart`, the HTTP relay) call this
  // synchronously, and the relay's call sits OUTSIDE its `localOpGuard.release`
  // path, so a sync throw would leak the clone lock (429s until restart) and
  // hang the response. Typed preflight failures carry recoverable install
  // guidance; any other error routes through the same contract rather than
  // escaping it.
  let detected: GitDetected;
  try {
    detected = assertGitAvailable();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
      emitPreflightFailureSpan(err);
      // Pair the span with a structured log (mirrors boot.ts). OTEL is off by
      // default, so this log line is the only field-visible signal for a
      // setup-boundary preflight failure on the clone path.
      log.warn(
        {
          event: 'git_preflight_fail',
          platform: err.platform,
          reason: err instanceof GitTooOldError ? 'too_old' : 'not_available',
          detectedVersion: err instanceof GitTooOldError ? err.detected : '',
        },
        err instanceof GitTooOldError ? 'git binary too old' : 'git binary not found',
      );
    } else {
      // An unexpected (non-preflight) error would otherwise be converted straight
      // to an error event with no server-side trace. Log it with the full error
      // (stack/type captured) so a setup-boundary failure on the clone path isn't
      // silently swallowed.
      log.error(
        {
          event: 'clone_preflight_unexpected_error',
          err,
        },
        'unexpected error during clone preflight',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    const done = Promise.resolve().then(() => {
      opts.onEvent({ type: 'error', message });
    });
    return { done, cancel: () => {} };
  }

  // Point the spawned clone's internal `git` at the binary the preflight
  // validated (closes the check/use divergence for the fallback-path case).
  // Only enrich for an ABSOLUTE resolved path: a non-absolute resolvedPath (the
  // bare `git` fallback) would make `dirname()` '.' and prepend the process cwd
  // to the child PATH (CWE-426/427) — and in that case the inherited PATH
  // already resolves a working git, so enrichment is unnecessary.
  const extraPathDirs = isAbsolute(detected.resolvedPath) ? [dirname(detected.resolvedPath)] : [];

  let sawTerminal = false;

  const branchArgs =
    typeof opts.branch === 'string' && opts.branch.length > 0 ? ['-b', opts.branch] : [];
  const proc = runSubprocess({
    cliArgs: opts.cliArgs,
    trailingArgs: ['clone', '--json', ...branchArgs, opts.url, targetDir],
    extraPathDirs,
    timeoutMs,
    onLine: ({ parsed }) => {
      if (!parsed) return;
      const event = asRawCloneEvent(parsed);
      if (!event) return;
      if (event.type === 'complete' || event.type === 'error') {
        sawTerminal = true;
      }
      opts.onEvent(event);
    },
  });

  const done = proc.done.then((result) => {
    if (sawTerminal) return;
    if (result.timedOut) {
      opts.onEvent({ type: 'error', message: 'Clone timed out after 10 minutes' });
      return;
    }
    if (result.code !== 0) {
      const detail = result.stderr ? ` — ${result.stderr}` : '';
      opts.onEvent({
        type: 'error',
        message: `Clone process exited with code ${result.code ?? -1}${detail}`,
      });
      return;
    }
    // CLI exited cleanly without emitting a terminal event — synthesize a
    // `complete` so the caller's stream resolves. Without this, the IPC
    // path's async iterator hangs forever waiting for a terminal event
    // that won't come. Mirrors `runDeviceFlowSubprocess`'s synthesis.
    opts.onEvent({ type: 'complete', dir: targetDir });
  });

  return { done, cancel: proc.cancel };
}
