#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const STOP_OUTCOMES = Object.freeze([
  'terminal',
  'transient-exhausted',
  'unknown-exhausted',
  'deadline',
  'signal',
  'attempt-timeout',
  'child-signal',
  'spawn-failure',
  'cleanup-failure',
]);

const MAX_CAPTURE_BYTES = 16_384;
const MIN_PROJECTED_ATTEMPT_MS = 1_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CLEANUP_GRACE_MS = 5_000;
const DEFAULT_CLEANUP_RESERVE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const STOP_OUTCOME_SET = new Set(STOP_OUTCOMES);
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 521, 522, 524]);
const TERMINAL_HTTP_STATUSES = new Set([400, 401, 404, 413, 422]);
const NETWORK_CODES = [
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
];
// STOP: Order selects the operator-facing reason; keep root causes first and download-integrity last.
const TERMINAL_RULES = [
  ['disk-full', /\bENOSPC\b|no space left on device/i],
  [
    'compiler',
    /(?:\berror TS\d+:|\b(?:compilation|electron-vite build|vite build|Rolldown build) failed\b)/i,
  ],
  [
    'configuration',
    /[\r\n]\s*(?:⨯\s*|(?:Error|FATAL):?\s*)?(?:invalid configuration object|configuration (?:is invalid|validation failed)|cannot find configuration|unknown (?:configuration )?option|ERR_PNPM_OUTDATED_LOCKFILE)\b/i,
  ],
  [
    'credentials',
    /\b(?:authentication failed|unauthorized credentials?|invalid credentials?|credentials? (?:are )?(?:missing|expired)|CSC_LINK is not set)\b/i,
  ],
  [
    'certificate',
    /\b(?:certificate (?:has )?(?:expired|not trusted|revoked)|CSSMERR_TP_CERT_|no (?:valid )?signing identity|specified item could not be found in the keychain|SecKeychainUnlock)\b/i,
  ],
  [
    'notarization-invalid',
    /(?:notari[sz]ation[^\r\n]*\bstatus["']?\s*[:=]\s*["']?Invalid\b|\bstatus["']?\s*[:=]\s*["']?Invalid\b[^\r\n]*notari[sz]|\bnotarytool\b[\s\S]{0,200}?\bstatus["']?\s*[:=]\s*["']?Invalid\b)/i,
  ],
  [
    'entitlement',
    /(?:\bentitlements?\b[^\r\n]*(?:not permitted|mismatch|rejected|failed)|(?:invalid|rejected)[^\r\n]*\bentitlements?\b)/i,
  ],
  [
    'fuse',
    /\bOK_PACKAGING_FUSE_FAILURE\b|\[afterSign\]\s+getCurrentFuseWire\s+failed\b|(?:\[after(?:Pack|Sign)\]\s+|\belectron\s+)fuse(?:s)?\b[^\r\n]*(?:\bmismatch(?:es|ed)?\b|\binvalid\b|\bfailed\b)/i,
  ],
  ['tls-trust', /\bNSURLErrorDomain\b[^\r\n]*\bCode=(?:-1201|-1202|-1203|-1204|-1205|-1206)\b/i],
  [
    'integrity',
    /\b(?:integrity check failed|code signature invalid|signature verification failed)\b/i,
  ],
  [
    'missing-executable',
    /(?:\bspawn\s+\S+\s+ENOENT\b|[\r\n]\s*Error:\s*Cannot find module\b|\bERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\b[^\r\n]*\bCommand\b[^\r\n]*\bnot found\b|[\r\n]\s*\S{0,256}(?:ba)?sh(?:\.exe)?:[^\r\n]{0,512}:\s*command not found\b)/i,
  ],
  ['download-integrity', /\b(?:checksum|hash) mismatch,\s*expected\b/i],
];
const TERMINAL_RULE_IDS = Object.freeze(TERMINAL_RULES.map(([id]) => id));
const TRANSIENT_RULES = [
  ['timestamp-missing', /A timestamp was expected but was not found/i],
  ['timestamp-service', /The timestamp service is not available/i],
  ['http-status-nil', /HTTPError\s*\(\s*statusCode\s*:\s*nil/i],
  ['request-timeout', /\bThe request timed out\b/i],
  ['network-lost', /\bThe network connection was lost\b/i],
  ['server-connect', /\bCould not connect to the server\b/i],
  ['socket-hangup', /\bsocket hang up\b/i],
  ['tls-disconnect', /\bClient network socket disconnected\b/i],
  ['unexpected-eof', /\bunexpected EOF\b/i],
  ['secondary-rate-limit', /\b(?:secondary rate limit|rate limit exceeded)\b/i],
  ['rate-limit-header', /\bX-RateLimit-Remaining\s*:\s*0\b/i],
  ['abuse-limit', /\babuse detection mechanism\b/i],
  ['submitted-too-fast', /\bwas submitted too quickly\b/i],
];

function appendUtf8Tail(current, chunk, limit) {
  const combined = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  if (combined.length <= limit) return combined;
  let start = combined.length - limit;
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1;
  return combined.subarray(start);
}

function collectStructuredEvidence(evidence, text) {
  const statusPattern =
    /(?:\bHTTP(?:Error)?(?:\/[0-9.]+)?(?:\s+status)?\s*[:=]?\s*|\bresponse\s+(?:status|code)\s*[:=]?\s*|\bstatusCode["']?\s*[:=]\s*)(\d{3})\b/gi;
  for (const match of text.matchAll(statusPattern)) {
    evidence.httpStatuses.add(Number(match[1]));
  }
  for (const match of text.matchAll(
    /[\r\n]\s*(?:⨯\s*|Error:\s*)?(408|429|500|502|503|504|521|522|524)\s+(?:Request Timeout|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Web Server Is Down|Connection Timed Out|A Timeout Occurred)\b/gi,
  )) {
    evidence.httpStatuses.add(Number(match[1]));
  }
  const networkPattern = new RegExp(`\\b(${NETWORK_CODES.join('|')})\\b`, 'gi');
  for (const match of text.matchAll(networkPattern)) {
    evidence.errorCodes.add(match[1].toUpperCase());
  }
  for (const match of text.matchAll(/\b(UND_ERR_(?:[A-Z_]*TIMEOUT|SOCKET))\b/gi)) {
    evidence.errorCodes.add(match[1].toUpperCase());
  }
  for (const match of text.matchAll(/\bcurl:\s*\((28|56)\)/gi)) {
    evidence.errorCodes.add(`CURL_${match[1]}`);
  }
  for (const match of text.matchAll(
    /\bNSURLErrorDomain\b[^\r\n]*\bCode=(-1001|-1003|-1004|-1005|-1006|-1008|-1009|-1011)\b/gi,
  )) {
    evidence.errorCodes.add(`NSURLError_${match[1]}`);
  }
}

function collectRetryAfterEvidence(evidence, text) {
  if (evidence.retryAfterValid) return;
  const match = /^\s*(?:<\s*)?Retry-After\s*:\s*(.*?)\s*$/i.exec(text);
  if (!match) return;
  const raw = match[1].replace(/^["']|["']$/g, '');
  const retryAt = /^\d+$/.test(raw) ? evidence.nowFn() + Number(raw) * 1000 : Date.parse(raw);
  if (!Number.isFinite(retryAt)) return;
  evidence.retryAfterValid = true;
  evidence.retryAfterEpochMs = retryAt;
}

function collectDecodedEvidence(evidence, decoded, final) {
  const joined = evidence.scanCarry + decoded;
  const scanText = evidence.scanStarted ? joined : `\n${joined}`;
  collectStructuredEvidence(evidence, scanText);
  collectPhraseEvidence(evidence, scanText);
  evidence.scanCarry = joined.slice(-2048);
  evidence.scanStarted ||= joined.length > 0;

  const retryText = evidence.retryAfterCarry + decoded;
  const retryLines = retryText.split(/\r\n|\r|\n/);
  evidence.retryAfterCarry = final ? '' : (retryLines.pop() ?? '').slice(-2048);
  for (const line of retryLines) collectRetryAfterEvidence(evidence, line);
}

function collectPhraseEvidence(evidence, text) {
  for (const [id, pattern] of TERMINAL_RULES) {
    if (pattern.test(text)) evidence.terminalRules.add(id);
  }
  for (const [id, pattern] of TRANSIENT_RULES) {
    if (pattern.test(text)) evidence.transientRules.add(id);
  }
}

export class FailureEvidence {
  constructor({ maxTailBytes = MAX_CAPTURE_BYTES, nowFn = Date.now } = {}) {
    this.httpStatuses = new Set();
    this.errorCodes = new Set();
    this.terminalRules = new Set();
    this.transientRules = new Set();
    this.retryAfterEpochMs = undefined;
    this.retryAfterValid = false;
    this.tailBytes = Buffer.alloc(0);
    this.tail = '';
    this.maxTailBytes = maxTailBytes;
    this.nowFn = nowFn;
    this.decoder = new StringDecoder('utf8');
    this.scanCarry = '';
    this.scanStarted = false;
    this.retryAfterCarry = '';
  }

  ingest(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    this.tailBytes = appendUtf8Tail(this.tailBytes, chunk, this.maxTailBytes);
    collectDecodedEvidence(this, this.decoder.write(chunk), false);
  }

  finish() {
    collectDecodedEvidence(this, this.decoder.end(), true);
    this.tail = this.tailBytes.toString('utf8');
    return this;
  }
}

class AttemptResult {
  constructor({
    code = null,
    closeSignal = null,
    cancellationSignal = null,
    cancelled = false,
    timedOut = false,
    deadlineExpired = false,
    spawnError = null,
    cleanup = { ok: true, reason: 'clean' },
    evidence = new FailureEvidence(),
  } = {}) {
    this.code = code;
    this.closeSignal = closeSignal;
    this.cancellationSignal = cancellationSignal;
    this.cancelled = cancelled;
    this.timedOut = timedOut;
    this.deadlineExpired = deadlineExpired;
    this.spawnError = spawnError;
    this.cleanup = cleanup;
    this.evidence = evidence;
  }
}

class RetryState {
  constructor() {
    this.attemptsStarted = 0;
    this.unknownRetryUsed = false;
    this.lastFailureClassification = undefined;
    this.lastAttemptDurationMs = undefined;
  }
}

export function classifyEvidence(evidence) {
  if (evidence.terminalRules.size > 0) return 'terminal';
  for (const status of evidence.httpStatuses) {
    if (TERMINAL_HTTP_STATUSES.has(status)) return 'terminal';
  }
  const rateLimited =
    evidence.transientRules.has('secondary-rate-limit') ||
    evidence.transientRules.has('rate-limit-header') ||
    evidence.transientRules.has('abuse-limit') ||
    evidence.transientRules.has('submitted-too-fast');
  if (evidence.httpStatuses.has(403) && !rateLimited) return 'terminal';
  if (evidence.errorCodes.size > 0 || evidence.transientRules.size > 0) return 'transient';
  for (const status of evidence.httpStatuses) {
    if (TRANSIENT_HTTP_STATUSES.has(status)) return 'transient';
  }
  if (evidence.httpStatuses.has(403) && rateLimited) return 'transient';
  return 'unknown';
}

function firstSorted(values) {
  return [...values].sort()[0];
}

function firstTerminalRule(values) {
  return TERMINAL_RULE_IDS.find((id) => values.has(id));
}

function matchedReason(evidence, classification) {
  const statuses = [...evidence.httpStatuses].sort((left, right) => left - right);
  if (classification === 'terminal') {
    const terminalRule = firstTerminalRule(evidence.terminalRules);
    if (terminalRule) return `rule:${terminalRule}`;
    const status = statuses.find(
      (candidate) => TERMINAL_HTTP_STATUSES.has(candidate) || candidate === 403,
    );
    return `http:${status}`;
  }
  if (classification === 'transient') {
    const errorCode = firstSorted(evidence.errorCodes);
    if (errorCode) return `code:${errorCode}`;
    const transientRule = firstSorted(evidence.transientRules);
    if (transientRule) return `rule:${transientRule}`;
    const status = statuses.find((candidate) => TRANSIENT_HTTP_STATUSES.has(candidate));
    return `http:${status}`;
  }
  return 'diagnostic:unknown';
}

function redactDiagnosticTail(tail) {
  const withoutPem = tail.replace(
    /(?:-----BEGIN [^-\r\n]+-----[\s\S]*?(?:-----END [^-\r\n]+-----|$)|(?:[A-Z0-9+/=]{20,}\r?\n)+-----END [^-\r\n]+-----)/gi,
    '[REDACTED PEM]',
  );
  return withoutPem.replace(
    /^(\s*["']?[A-Z0-9_.-]*(?:API[-_]?KEY|AUTHORIZATION|CREDENTIAL|PASSWORD|SECRET|TOKEN)[A-Z0-9_.-]*["']?\s*[:=]\s*)[^\r\n]*/gim,
    '$1[REDACTED]',
  );
}

function emitDiagnostic(log, label, evidence) {
  log(`::group::${label} bounded failure diagnostic`);
  const safe = redactDiagnosticTail(evidence.tail || '(no child diagnostic captured)');
  for (const line of safe.split(/\r\n|\r|\n/)) log(`| ${line.replaceAll('##[', '# #[')}`);
  log('::endgroup::');
}

function projectedAttemptMs(durationMs, attemptTimeoutMs) {
  return Math.min(
    attemptTimeoutMs,
    Math.max(MIN_PROJECTED_ATTEMPT_MS, Math.ceil(durationMs * 1.25)),
  );
}

function logDecision({
  log,
  level,
  label,
  action,
  reason,
  attempt,
  maxAttempts,
  result,
  signal,
  matched,
  detail,
  outcome,
  classification,
}) {
  const annotation = level === 'warning' ? '::warning::' : '::error::';
  const code = result?.code ?? 'none';
  const signalFact = signal ?? result?.cancellationSignal ?? result?.closeSignal ?? 'none';
  const matchedFact = matched ? ` matched=${matched}` : '';
  const detailFact = detail ? ` ${detail}` : '';
  const outcomeFact = outcome ? ` outcome=${outcome}` : '';
  const classificationFact = classification ? ` classification=${classification}` : '';
  const cleanupFact = result?.cleanup?.ok === false ? ` cleanup=${result.cleanup.reason}` : '';
  log(
    `${annotation}${label} decision=${action} reason=${reason}${outcomeFact}${classificationFact} attempt=${attempt}/${maxAttempts} code=${code} signal=${signalFact}${cleanupFact}${matchedFact}${detailFact}`,
  );
  if (action === 'stop' && !STOP_OUTCOME_SET.has(outcome)) {
    if (result) emitDiagnostic(log, label, result.evidence);
    throw new Error(`${label}: stop decision has unregistered outcome ${outcome ?? 'none'}`);
  }
}

function positiveJitterMs(minimumMs, randomFn) {
  const ceiling = Math.max(1, Math.min(5_000, Math.ceil(minimumMs * 0.1)));
  return Math.min(ceiling, Math.max(1, Math.floor(randomFn() * ceiling) + 1));
}

export function computeRetryDelayMs(
  retryNumber,
  evidence,
  { randomFn = Math.random, nowMs = Date.now() } = {},
) {
  const baseMs = retryNumber === 1 ? 30_000 : 60_000;
  const minimumMs = Math.max(baseMs, retryAfterDelayMs(evidence, nowMs) ?? 0);
  return minimumMs + positiveJitterMs(minimumMs, randomFn);
}

function retryAfterDelayMs(evidence, nowMs) {
  if (!evidence.retryAfterValid) return undefined;
  return Math.max(0, (evidence.retryAfterEpochMs ?? nowMs) - nowMs);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, intervalMs, sleepFn) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) return false;
    await sleepFn(Math.min(intervalMs, Math.max(1, end - Date.now())));
  }
  return true;
}

function processGroupExists(pid, killFn) {
  try {
    killFn(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function sendGroupSignal(pid, signal, killFn) {
  try {
    killFn(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function defaultTaskkill(args) {
  return new Promise((resolve) => {
    const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    let settled = false;
    child.once('error', () => {
      if (!settled) resolve({ ok: false });
      settled = true;
    });
    child.once('close', (code) => {
      if (!settled) resolve({ ok: code === 0 });
      settled = true;
    });
  });
}

export function createOwnedTreeController({
  platform = process.platform,
  killFn = process.kill.bind(process),
  taskkillFn = defaultTaskkill,
  sleepFn = delay,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (platform === 'win32') {
    return {
      async cleanup(pid, { graceMs, waitForClose }) {
        if (await waitForClose(0)) return { ok: true, reason: 'clean' };
        const graceful = await taskkillFn(['/PID', String(pid), '/T']);
        if (graceful.ok && (await waitForClose(graceMs))) {
          return { ok: true, reason: 'clean' };
        }
        const forced = await taskkillFn(['/PID', String(pid), '/T', '/F']);
        if (!forced.ok) return { ok: false, reason: 'taskkill-failure' };
        if (!(await waitForClose(graceMs))) {
          return { ok: false, reason: 'close-not-observed' };
        }
        return { ok: true, reason: 'clean' };
      },
    };
  }
  return {
    async cleanup(pid, { graceMs, cleanupReserveMs, waitForClose }) {
      if (!processGroupExists(pid, killFn)) {
        return (await waitForClose(graceMs))
          ? { ok: true, reason: 'clean' }
          : { ok: false, reason: 'close-not-observed' };
      }
      if (!sendGroupSignal(pid, 'SIGTERM', killFn)) {
        return { ok: false, reason: 'signal-send-failure' };
      }
      const goneAfterTerm = await waitUntil(
        () => !processGroupExists(pid, killFn),
        graceMs,
        pollIntervalMs,
        sleepFn,
      );
      if (!goneAfterTerm) {
        if (!sendGroupSignal(pid, 'SIGKILL', killFn)) {
          return { ok: false, reason: 'signal-send-failure' };
        }
        const goneAfterKill = await waitUntil(
          () => !processGroupExists(pid, killFn),
          cleanupReserveMs,
          pollIntervalMs,
          sleepFn,
        );
        if (!goneAfterKill) return { ok: false, reason: 'tree-survived-kill' };
      }
      return (await waitForClose(cleanupReserveMs))
        ? { ok: true, reason: 'clean' }
        : { ok: false, reason: 'close-not-observed' };
    },
  };
}

function waitForPromise(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function commandInvocation(command, shell, platform) {
  if (!shell) return { executable: command[0], args: command.slice(1) };
  if (platform === 'win32') {
    return {
      executable: 'bash',
      args: ['-c', command[0]],
    };
  }
  return { executable: '/bin/bash', args: ['-c', command[0]] };
}

async function runAttempt({
  command,
  shell,
  spawnFn,
  platform,
  cancellationSignal,
  deadlineEpochMs,
  attemptTimeoutMs,
  cleanupReserveMs,
  cleanupGraceMs,
  treeController,
  nowFn,
}) {
  const evidence = new FailureEvidence({ nowFn });
  const invocation = commandInvocation(command, shell, platform);
  let child;
  try {
    child = spawnFn(invocation.executable, invocation.args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: platform === 'win32',
    });
  } catch (error) {
    evidence.ingest(Buffer.from(`${error.message}\n`));
    evidence.finish();
    return new AttemptResult({
      spawnError: error,
      cleanup: { ok: true, reason: 'not-required' },
      evidence,
    });
  }

  child.stdout?.on('data', (chunk) => {
    evidence.ingest(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    evidence.ingest(chunk);
    process.stderr.write(chunk);
  });

  let closeValue;
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
    evidence.ingest(Buffer.from(`${error.message}\n`));
    resolveClose({ kind: 'spawn-error', code: null, signal: null });
  });
  child.once('close', (code, signal) => {
    closeValue = { kind: 'close', code, signal };
    resolveClose(closeValue);
  });

  let timeoutId;
  let deadlineId;
  let cancelListener;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: 'attempt-timeout' }), attemptTimeoutMs);
  });
  const remainingToDeadline = Math.max(0, deadlineEpochMs - cleanupReserveMs - nowFn());
  const deadlinePromise = new Promise((resolve) => {
    deadlineId = setTimeout(() => resolve({ kind: 'deadline' }), remainingToDeadline);
  });
  const cancellationPromise = new Promise((resolve) => {
    cancelListener = () =>
      resolve({ kind: 'cancelled', signal: cancellationSignal.reason || 'SIGTERM' });
    if (cancellationSignal.aborted) cancelListener();
    else cancellationSignal.addEventListener('abort', cancelListener, { once: true });
  });

  const outcome = await Promise.race([
    closePromise,
    timeoutPromise,
    deadlinePromise,
    cancellationPromise,
  ]);
  clearTimeout(timeoutId);
  clearTimeout(deadlineId);
  cancellationSignal.removeEventListener('abort', cancelListener);

  const waitForClose = (timeoutMs) => waitForPromise(closePromise, timeoutMs);
  let cleanup = { ok: true, reason: 'clean' };
  if (child.pid) {
    cleanup = await treeController.cleanup(child.pid, {
      graceMs: cleanupGraceMs,
      cleanupReserveMs,
      waitForClose,
    });
  } else if (outcome.kind !== 'close' && outcome.kind !== 'spawn-error') {
    cleanup = { ok: false, reason: 'close-not-observed' };
  }
  if (!closeValue && outcome.kind !== 'spawn-error') {
    await waitForClose(cleanupReserveMs);
  }
  evidence.finish();

  return new AttemptResult({
    code: closeValue?.code ?? outcome.code ?? null,
    closeSignal: closeValue?.signal ?? null,
    cancellationSignal: outcome.kind === 'cancelled' ? outcome.signal : null,
    cancelled: outcome.kind === 'cancelled',
    timedOut: outcome.kind === 'attempt-timeout',
    deadlineExpired: outcome.kind === 'deadline',
    spawnError,
    cleanup,
    evidence,
  });
}

function processStop(result, attempts) {
  if (result.cancelled) {
    return { ok: false, reason: 'signal', signal: result.cancellationSignal, attempts };
  }
  if (result.timedOut) return { ok: false, reason: 'attempt-timeout', attempts };
  if (result.deadlineExpired) return { ok: false, reason: 'deadline', attempts };
  if (result.spawnError) {
    return { ok: false, reason: 'spawn-failure', attempts, error: result.spawnError.message };
  }
  if (!result.cleanup.ok) {
    return {
      ok: false,
      reason: 'cleanup-failure',
      cleanup: result.cleanup.reason,
      attempts,
    };
  }
  if (result.closeSignal) {
    return { ok: false, reason: 'child-signal', signal: result.closeSignal, attempts };
  }
  return undefined;
}

function installSignalHandlers(signalSource, controller) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!controller.signal.aborted) controller.abort(signal);
    };
    handlers.set(signal, handler);
    signalSource.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler);
  };
}

async function waitForBackoff(ms, cancellationSignal, sleepFn) {
  if (cancellationSignal.aborted) return false;
  let abortListener;
  const aborted = new Promise((resolve) => {
    abortListener = () => resolve(false);
    cancellationSignal.addEventListener('abort', abortListener, { once: true });
  });
  const slept = Promise.resolve(sleepFn(ms, cancellationSignal)).then(
    () => !cancellationSignal.aborted,
  );
  const completed = await Promise.race([slept, aborted]);
  cancellationSignal.removeEventListener('abort', abortListener);
  return completed;
}

export async function runWithRetry({
  command,
  label = 'command',
  shell = false,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  deadlineEpochMs = Date.now() + 60 * 60 * 1000,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  cleanupReserveMs = DEFAULT_CLEANUP_RESERVE_MS,
  cleanupGraceMs = DEFAULT_CLEANUP_GRACE_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  spawnFn = spawn,
  sleepFn = (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
  randomFn = Math.random,
  nowFn = Date.now,
  log = console.log,
  retryWarning = '',
  signalSource = process,
  platform = process.platform,
  treeController,
  attemptRunner = runAttempt,
} = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFAULT_MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${DEFAULT_MAX_ATTEMPTS}`);
  }
  const state = new RetryState();
  const cancellation = new AbortController();
  const removeSignalHandlers = installSignalHandlers(signalSource, cancellation);
  const ownedTree =
    treeController ??
    createOwnedTreeController({
      platform,
      pollIntervalMs,
    });
  const recordDecision = (level, action, reason, result, facts = {}) =>
    logDecision({
      log,
      level,
      label,
      action,
      reason,
      attempt: state.attemptsStarted,
      maxAttempts,
      result,
      ...facts,
    });
  const finishFailure = (failure, result) => {
    if (result) emitDiagnostic(log, label, result.evidence);
    return failure;
  };

  try {
    while (state.attemptsStarted < maxAttempts) {
      if (cancellation.signal.aborted) {
        recordDecision('error', 'stop', 'control:signal', undefined, {
          outcome: 'signal',
          signal: cancellation.signal.reason,
        });
        return {
          ok: false,
          reason: 'signal',
          signal: cancellation.signal.reason,
          attempts: state.attemptsStarted,
        };
      }
      const admissionMs = state.lastAttemptDurationMs
        ? projectedAttemptMs(state.lastAttemptDurationMs, attemptTimeoutMs)
        : MIN_PROJECTED_ATTEMPT_MS;
      if (nowFn() + admissionMs + cleanupReserveMs > deadlineEpochMs) {
        recordDecision('error', 'stop', 'control:deadline', undefined, {
          outcome: 'deadline',
          detail: 'phase=before-attempt',
        });
        return { ok: false, reason: 'deadline', attempts: state.attemptsStarted };
      }

      state.attemptsStarted += 1;
      log(`::group::${label} attempt ${state.attemptsStarted}/${maxAttempts}`);
      const attemptStartedAt = nowFn();
      const result = await attemptRunner({
        command,
        shell,
        spawnFn,
        platform,
        cancellationSignal: cancellation.signal,
        deadlineEpochMs,
        attemptTimeoutMs,
        cleanupReserveMs,
        cleanupGraceMs,
        treeController: ownedTree,
        nowFn,
      });
      state.lastAttemptDurationMs = Math.max(0, nowFn() - attemptStartedAt);
      log('::endgroup::');

      const stopped = processStop(result, state.attemptsStarted);
      if (stopped) {
        recordDecision('error', 'stop', `control:${stopped.reason}`, result, {
          outcome: stopped.reason,
          signal: stopped.signal,
          detail: stopped.reason === 'deadline' ? 'phase=mid-attempt' : undefined,
        });
        return finishFailure(stopped, result);
      }
      if (result.code === 0) {
        log(`${label} succeeded on attempt ${state.attemptsStarted}.`);
        return {
          ok: true,
          attempts: state.attemptsStarted,
          recoveredFrom: state.attemptsStarted > 1 ? state.lastFailureClassification : undefined,
        };
      }

      const classification = classifyEvidence(result.evidence);
      const reasonId = matchedReason(result.evidence, classification);
      state.lastFailureClassification = classification;
      if (classification === 'terminal') {
        recordDecision('error', 'stop', reasonId, result, { outcome: 'terminal' });
        return finishFailure(
          {
            ok: false,
            reason: 'terminal',
            attempts: state.attemptsStarted,
            code: result.code,
          },
          result,
        );
      }
      if (classification === 'unknown') {
        if (state.unknownRetryUsed) {
          recordDecision('error', 'stop', reasonId, result, {
            outcome: 'unknown-exhausted',
            detail: 'allowance=already-used',
          });
          return finishFailure(
            {
              ok: false,
              reason: 'unknown-exhausted',
              attempts: state.attemptsStarted,
              code: result.code,
            },
            result,
          );
        }
        state.unknownRetryUsed = true;
      }
      if (state.attemptsStarted >= maxAttempts) {
        const reason = classification === 'transient' ? 'transient-exhausted' : 'unknown-exhausted';
        recordDecision('error', 'stop', reasonId, result, {
          outcome: reason,
          detail: `attempt-bound=${reason}`,
        });
        return finishFailure(
          { ok: false, reason, attempts: state.attemptsStarted, code: result.code },
          result,
        );
      }

      const decisionNow = nowFn();
      const delayMs = computeRetryDelayMs(state.attemptsStarted, result.evidence, {
        randomFn,
        nowMs: decisionNow,
      });
      const nextAttemptMs = projectedAttemptMs(state.lastAttemptDurationMs, attemptTimeoutMs);
      if (decisionNow + delayMs + nextAttemptMs + cleanupReserveMs > deadlineEpochMs) {
        const retryAfterMs = retryAfterDelayMs(result.evidence, decisionNow);
        recordDecision('error', 'stop', 'control:deadline', result, {
          outcome: 'deadline',
          matched: reasonId,
          detail: [
            'phase=before-backoff',
            retryAfterMs === undefined ? undefined : `retry-after-ms=${retryAfterMs}`,
            `projected-attempt-ms=${nextAttemptMs}`,
          ]
            .filter(Boolean)
            .join(' '),
        });
        return finishFailure(
          { ok: false, reason: 'deadline', attempts: state.attemptsStarted },
          result,
        );
      }
      if (retryWarning) log(`::warning::${retryWarning}`);
      recordDecision('warning', 'retry', reasonId, result, {
        classification,
        detail:
          classification === 'unknown'
            ? `UNKNOWN_CLASSIFICATION_RETRY allowance=invocation-wide-single-use delay-ms=${delayMs}`
            : `delay-ms=${delayMs}`,
      });
      if (!(await waitForBackoff(delayMs, cancellation.signal, sleepFn))) {
        recordDecision('error', 'stop', 'control:signal', result, {
          outcome: 'signal',
          signal: cancellation.signal.reason,
          matched: reasonId,
          detail: 'phase=backoff',
        });
        return finishFailure(
          {
            ok: false,
            reason: 'signal',
            signal: cancellation.signal.reason,
            attempts: state.attemptsStarted,
          },
          result,
        );
      }
    }
    throw new Error(
      `${label}: retry state exhausted unexpectedly after ${state.attemptsStarted}/${maxAttempts} attempts`,
    );
  } finally {
    removeSignalHandlers();
  }
}

function parseDuration(value, flag) {
  const match = /^(\d+)(ms|s|m)$/.exec(value ?? '');
  if (!match) throw new Error(`${flag} must be a positive duration such as 30m`);
  const multiplier = match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1;
  const duration = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(`${flag} must be a positive duration`);
  }
  return duration;
}

function flagValue(flags, name, required = false) {
  const index = flags.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  return flags[index + 1];
}

export function parseArgs(argv) {
  const rest = argv.slice(2);
  const separator = rest.indexOf('--');
  if (separator === -1) throw new Error('a `--` separator followed by the command is required');
  const flags = rest.slice(0, separator);
  const command = rest.slice(separator + 1);
  if (command.length === 0) throw new Error('no command given after `--`');
  const allowedFlags = new Set([
    '--label',
    '--max-attempts',
    '--deadline-epoch-ms',
    '--attempt-timeout',
    '--retry-warning',
    '--shell',
  ]);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (!allowedFlags.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (flag === '--shell') continue;
    const value = flags[index + 1];
    if (
      value === undefined ||
      value.startsWith('--') ||
      (value === '' && flag !== '--retry-warning')
    ) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
  }

  const shell = flags.includes('--shell');
  if (shell && command.length !== 1) throw new Error('--shell takes exactly one command string');
  const maxAttempts = Number(flagValue(flags, '--max-attempts') ?? DEFAULT_MAX_ATTEMPTS);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFAULT_MAX_ATTEMPTS) {
    throw new Error(`--max-attempts must be between 1 and ${DEFAULT_MAX_ATTEMPTS}`);
  }
  const deadlineEpochMs = Number(flagValue(flags, '--deadline-epoch-ms', true));
  if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= 0) {
    throw new Error('--deadline-epoch-ms must be a positive integer');
  }
  const attemptTimeoutMs = parseDuration(
    flagValue(flags, '--attempt-timeout', true),
    '--attempt-timeout',
  );
  return {
    label: flagValue(flags, '--label') ?? 'command',
    maxAttempts,
    deadlineEpochMs,
    attemptTimeoutMs,
    retryWarning: flagValue(flags, '--retry-warning') ?? '',
    shell,
    command,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runWithRetry(parseArgs(process.argv));
    if (result.reason === 'signal' && result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      process.exitCode = result.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
