#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_ATTEMPTS = 3;

export const TRANSIENT_SIGNATURES = [
  'A timestamp was expected but was not found',
  'The timestamp service is not available',
  'HTTPError\\(statusCode: nil',
  'The request timed out',
  'NSURLErrorDomain Code=-100[13459]',
  'kCFErrorDomainCFNetwork',
  'The network connection was lost',
  'Could not connect to the server',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'socket hang up',
  'Client network socket disconnected',
  'unexpected EOF',
  '502 Bad Gateway',
  '503 Service Unavailable',
  '504 Gateway Time-?out',
  'You have exceeded a secondary rate limit',
  'abuse detection mechanism',
  'was submitted too quickly',
];

const TRANSIENT_RE = new RegExp(TRANSIENT_SIGNATURES.join('|'), 'i');

export function isTransient(output) {
  return TRANSIENT_RE.test(String(output ?? ''));
}

export function backoffSeconds(attempt) {
  return attempt * 30;
}

const MAX_CAPTURE_BYTES = 2_000_000;

function appendCapped(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
}

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
  try {
    const result = await runWithRetry(parseArgs(process.argv));
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
