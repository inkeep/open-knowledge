
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

export type RawCloneEvent =
  | { type: 'progress'; phase: string; pct: number }
  | { type: 'complete'; dir: string }
  | { type: 'branch-fallback'; branch: string }
  | { type: 'error'; message: string };

export interface RunCloneOptions {
  cliArgs: readonly string[];
  url: string;
  dir: string;
  branch?: string | null;
  timeoutMs?: number;
  onEvent: (event: RawCloneEvent) => void;
}

export interface RunCloneController {
  done: Promise<void>;
  cancel(): void;
}

type CloneInputValidation = { ok: true } | { ok: false; reason: 'invalid-url' | 'invalid-dir' };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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

export function runCloneSubprocess(opts: RunCloneOptions): RunCloneController {
  const targetDir = expandTilde(opts.dir);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let detected: GitDetected;
  try {
    detected = assertGitAvailable();
  } catch (err) {
    if (err instanceof GitNotAvailableError || err instanceof GitTooOldError) {
      emitPreflightFailureSpan(err);
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
    opts.onEvent({ type: 'complete', dir: targetDir });
  });

  return { done, cancel: proc.cancel };
}
