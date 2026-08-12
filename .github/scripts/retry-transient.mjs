#!/usr/bin/env node
/**
 * Bounded, allowlist-gated retry for the release packaging invocations.
 *
 * electron-builder shells out to signing, notarization, and tool-download
 * steps that it will not retry itself: each `codesign --timestamp` is a single
 * un-retried call, and app-builder's download path aborts on one dropped
 * connection. A dropped response therefore aborts the whole build, leaving no
 * durable artifact and stranding the release as a draft. The only lever
 * available is re-running the whole invocation.
 *
 * CRITICAL: retry is gated on a transient-signature allowlist matched against
 * the captured output. Anything NOT on the allowlist — an expired or invalid
 * cert, a notarization REJECTION, an entitlements error, a developer-agreement
 * 403, or a real build/compile error — fails LOUD on the first attempt and is
 * never masked by a blind retry. A retry that can hide a real failure is worse
 * than no retry at all, because it converts a clear red into a slow flake.
 *
 * Usage:
 *   node retry-transient.mjs --label "electron-builder (linux)" -- pnpm exec electron-builder --linux
 *   node retry-transient.mjs --label "…" --shell -- 'pnpm run build && pnpm exec electron-builder --mac'
 *
 * Exit code is the command's own on success, or 1 when retries are refused or
 * exhausted.
 */

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Extended-regex allowlist of transient infra-flake signatures, matched
 * case-insensitively against combined stdout+stderr. Keep this list narrow:
 * every entry must be an out-of-our-control infra flake, never a signature a
 * real cert/notary/entitlements/build error could emit.
 *
 * The signing/notarization entries are macOS-only in practice but stay in the
 * shared list — a signature that cannot match on a platform costs nothing, and
 * per-platform lists would drift.
 */
export const TRANSIENT_SIGNATURES = [
  // Apple TSA + notarization round-trips.
  'A timestamp was expected but was not found',
  'The timestamp service is not available',
  'HTTPError\\(statusCode: nil',
  'The request timed out',
  'NSURLErrorDomain Code=-100[13459]',
  'kCFErrorDomainCFNetwork',
  // Generic transport failures, including the dropped tool/runtime downloads
  // that abort packaging on every platform.
  'The network connection was lost',
  'Could not connect to the server',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'socket hang up',
  'Client network socket disconnected',
  'unexpected EOF',
  // Upstream service degradation (GitHub asset hosts, Azure signing endpoint).
  '502 Bad Gateway',
  '503 Service Unavailable',
  '504 Gateway Time-?out',
  'You have exceeded a secondary rate limit',
  'abuse detection mechanism',
  'was submitted too quickly',
];

const TRANSIENT_RE = new RegExp(TRANSIENT_SIGNATURES.join('|'), 'i');

/** True when the captured output carries a known infra-flake signature. */
export function isTransient(output) {
  return TRANSIENT_RE.test(String(output ?? ''));
}

/** Matches the previous in-workflow behavior: 30s, then 60s. */
export function backoffSeconds(attempt) {
  return attempt * 30;
}

/**
 * Cap on retained output. electron-builder is verbose and the whole point of
 * retaining anything is the classification grep, which only ever needs the
 * failure text near the end.
 */
const MAX_CAPTURE_BYTES = 2_000_000;

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
}

/**
 * Run once, streaming output to this process's stdout/stderr while capturing
 * it for classification. Streaming is not optional: a packaging build that
 * only surfaced its log after exiting would make a hung build undebuggable.
 */
function runOnce(command, { shell = false, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const child = shell
      ? spawnFn('bash', ['-c', command[0]], { stdio: ['inherit', 'pipe', 'pipe'] })
      : spawnFn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });

    let captured = '';
    child.stdout?.on('data', (d) => {
      const text = d.toString();
      captured = appendCapped(captured, text);
      process.stdout.write(text);
    });
    child.stderr?.on('data', (d) => {
      const text = d.toString();
      captured = appendCapped(captured, text);
      process.stderr.write(text);
    });

    child.on('error', (err) => {
      const text = `${err.message}\n`;
      captured = appendCapped(captured, text);
      process.stderr.write(text);
      resolve({ code: 1, output: captured });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, output: captured }));
  });
}

/**
 * Outcome shapes, all reported to the caller rather than thrown, so the CLI
 * layer owns process exit and the tests can assert without catching:
 *   { ok: true,  attempts }                       — succeeded
 *   { ok: false, reason: 'non-transient', … }     — refused to retry
 *   { ok: false, reason: 'exhausted', … }         — retried and still failed
 */
export async function runWithRetry({
  command,
  label = 'command',
  shell = false,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  spawnFn = spawn,
  sleepFn = (s) => new Promise((r) => setTimeout(r, s * 1000)),
  log = console.log,
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    log(`::group::${label} attempt ${attempt}/${maxAttempts}`);
    const { code, output } = await runOnce(command, { shell, spawnFn });
    log('::endgroup::');

    if (code === 0) {
      log(`${label} succeeded on attempt ${attempt}.`);
      return { ok: true, attempts: attempt };
    }

    if (!isTransient(output)) {
      log(
        `::error::${label} failed on attempt ${attempt} with a NON-transient error (no known infra-flake signature matched). Not retrying — a real signing/notarize/cert/entitlements/build failure must fail loud, not be masked. See the log above.`,
      );
      return { ok: false, reason: 'non-transient', attempts: attempt, code };
    }

    if (attempt >= maxAttempts) {
      log(
        `::error::${label} failed after ${maxAttempts} attempts; the last failure matched a transient infra signature but retries are exhausted.`,
      );
      return { ok: false, reason: 'exhausted', attempts: attempt, code };
    }

    const backoff = backoffSeconds(attempt);
    log(
      `::warning::${label} attempt ${attempt} failed with a transient infra signature; retrying in ${backoff}s (bounded transient-only retry).`,
    );
    await sleepFn(backoff);
  }
}

export function parseArgs(argv) {
  const rest = argv.slice(2);
  const sep = rest.indexOf('--');
  if (sep === -1) throw new Error('a `--` separator followed by the command is required');
  const flags = rest.slice(0, sep);
  const command = rest.slice(sep + 1);
  if (command.length === 0) throw new Error('no command given after `--`');

  const shell = flags.includes('--shell');
  if (shell && command.length !== 1) {
    throw new Error('--shell takes exactly one command string');
  }

  const labelIdx = flags.indexOf('--label');
  const attemptsIdx = flags.indexOf('--max-attempts');
  return {
    label: labelIdx === -1 ? 'command' : (flags[labelIdx + 1] ?? 'command'),
    maxAttempts:
      attemptsIdx === -1 ? DEFAULT_MAX_ATTEMPTS : Number(flags[attemptsIdx + 1]) || DEFAULT_MAX_ATTEMPTS,
    shell,
    command,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // `process.exitCode`, never `process.exit()`: the latter discards whatever is
  // still queued on stdout when stdout is a pipe, which is exactly how Actions
  // captures step output. This module streams the whole packaging log, so a
  // truncated tail would drop the failure text a reader needs most.
  try {
    const result = await runWithRetry(parseArgs(process.argv));
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
