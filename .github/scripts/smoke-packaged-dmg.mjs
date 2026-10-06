#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withMountedDmg } from './dmg-mount.mjs';

export const VERDICT = {
  pass: 'pass',
  fail: 'fail',
  error: 'error',
};

export const EXIT_CODES = {
  [VERDICT.pass]: 0,
  [VERDICT.fail]: 1,
  [VERDICT.error]: 2,
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const DESKTOP_DIR = resolve(SCRIPT_DIR, '..', '..', 'packages', 'desktop');
const PACKAGED_CONFIG = 'playwright.packaged.config.ts';
export const PACKAGED_REPORT = join('test-results', 'desktop-smoke-packaged-results.json');

export const PROGRESS_FILE_ENV = 'OK_SMOKE_PROGRESS_FILE';
export const PLAYWRIGHT_REPORTER_ENV = 'PW_TEST_REPORTER';

export const WATCHDOG = {
  stallWindowMs: 10 * 60_000,
  stallWindowTestTimeouts: 4,
  pollMs: 1_000,
  stopGraceMs: 10_000,
  drainMs: 2_000,
  diagnosticBoundMs: 15_000,
};

const RECENT_EVENTS_KEPT = 12;
const OUTPUT_TAIL_LINES = 80;
const DIAGNOSTIC_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
const DIAGNOSTIC_LINE_CAP_CHARS = 400;
const EXIT_FLUSH_BOUND_MS = 10_000;

const PROCESS_TABLE_COLUMNS = 'pid,ppid,pgid,etime,pcpu,pmem,rss,stat,command';

const ON_SCREEN_WINDOWS_JXA = `ObjC.import('CoreGraphics');
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
const rows = ['owner-pid\\tlayer\\towner\\ttitle'];
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i);
  const get = (k) => { const v = w.objectForKey(k); return v && !v.isNil() ? String(ObjC.unwrap(v)) : ''; };
  rows.push([get('kCGWindowOwnerPID'), get('kCGWindowLayer'), get('kCGWindowOwnerName'), get('kCGWindowName')].join('\\t'));
}
rows.join('\\n');`;

function testTitle(test) {
  return test.titlePath().filter(Boolean).join(' › ');
}

export default class SmokeProgressReporter {
  constructor() {
    this.progressFile = process.env[PROGRESS_FILE_ENV] || null;
    this.failedWrites = 0;
    this.record(() => ({ kind: 'ready' }));
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    this.record(() => ({
      kind: 'begin',
      tests: suite.allTests().length,
      testTimeoutMs: Math.max(0, ...config.projects.map((project) => project.timeout ?? 0)),
    }));
  }

  onTestBegin(test, result) {
    this.record(() => ({ kind: 'test-begin', test: testTitle(test), retry: result.retry }));
  }

  onStepBegin(test, result, step) {
    this.record(() => ({
      kind: 'step-begin',
      test: testTitle(test),
      retry: result.retry,
      step: step.title,
      category: step.category,
    }));
  }

  onStepEnd(test, result, step) {
    this.record(() => ({
      kind: 'step-end',
      test: testTitle(test),
      retry: result.retry,
      step: step.title,
      category: step.category,
    }));
  }

  onTestEnd(test, result) {
    this.record(() => ({
      kind: 'test-end',
      test: testTitle(test),
      retry: result.retry,
      status: result.status,
      durationMs: result.duration,
    }));
  }

  onEnd(result) {
    this.record(() => ({ kind: 'end', status: result.status, failedWrites: this.failedWrites }));
  }

  record(describeEvent) {
    if (!this.progressFile) return;
    let event;
    try {
      event = describeEvent();
    } catch (err) {
      event = { kind: 'unrecorded', error: err?.message ?? String(err) };
    }
    try {
      appendFileSync(
        this.progressFile,
        `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      );
    } catch (err) {
      this.failedWrites += 1;
      if (this.failedWrites === 1) {
        process.stderr.write(
          `[smoke-packaged-dmg] the progress reporter could not append to ${this.progressFile}: ${err?.message ?? String(err)}; later progress events are not recorded, so the no-progress watchdog may stop this run as a stall\n`,
        );
      }
    }
  }
}

function clipLine(line) {
  return line.length > DIAGNOSTIC_LINE_CAP_CHARS
    ? `${line.slice(0, DIAGNOSTIC_LINE_CAP_CHARS)}…`
    : line;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function describeProgressEvent(event) {
  if (!event) return 'none';
  const parts = [event.kind ?? 'unknown'];
  if (event.test) parts.push(`"${event.test}"`);
  if (event.step) parts.push(`step "${event.step}"`);
  if (event.retry) parts.push(`retry ${event.retry}`);
  if (event.status) parts.push(event.status);
  if (event.at) parts.push(`at ${event.at}`);
  return parts.join(' ');
}

export function stallReason(stall) {
  const last = stall.recent.at(-1);
  return `the smoke stalled: no Playwright progress for ${formatDuration(stall.silentMs)} (watchdog window ${formatDuration(stall.windowMs)}); the last progress was ${describeProgressEvent(last)}. The run was stopped, and its diagnostics are in the step log`;
}

export function classifyRun({ runExitCode, runSignal, report, runnerError, stall }) {
  if (stall) {
    return { verdict: VERDICT.error, reason: stallReason(stall) };
  }
  if (runnerError) {
    return {
      verdict: VERDICT.error,
      reason: `the Playwright runner could not be started: ${runnerError}`,
    };
  }
  if (report === null || report === undefined) {
    const missing =
      'the Playwright JSON report was missing or unparseable, so no verdict could be read from the run';
    return {
      verdict: VERDICT.error,
      reason: runSignal ? `${missing}; the Playwright runner was ended by ${runSignal}` : missing,
    };
  }
  const stats = report.stats ?? {};
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;
  const executed = expected + unexpected + flaky;

  if (executed === 0) {
    return {
      verdict: VERDICT.error,
      reason: `no smoke test actually executed (${skipped} skipped) — an all-skipped run proves nothing about the DMG and must never read as a pass`,
    };
  }
  if (unexpected > 0) {
    return {
      verdict: VERDICT.fail,
      reason: `${unexpected} of ${executed} executed smoke tests failed against the packaged app`,
    };
  }
  if (runExitCode !== 0) {
    const ended = runSignal ? `was ended by ${runSignal}` : `exited ${runExitCode}`;
    return {
      verdict: VERDICT.error,
      reason: `the Playwright runner ${ended} with no failing test — treat as an infrastructure problem, not an app verdict`,
    };
  }
  return {
    verdict: VERDICT.pass,
    reason: `all ${executed} executed smoke tests passed against the packaged app (${flaky} flaky, ${skipped} skipped)`,
  };
}

export function annotationFor(verdict, reason, dmgPath) {
  if (verdict === VERDICT.pass) {
    return `::notice::DMG smoke PASSED for ${dmgPath} — ${reason}`;
  }
  if (verdict === VERDICT.fail) {
    return `::warning::DMG smoke FAILED (the app misbehaved) for ${dmgPath} — ${reason}`;
  }
  return `::warning::DMG smoke ERRORED (infrastructure, not an app verdict) for ${dmgPath} — ${reason}`;
}

export function publishVerdict({ verdict, reason }, deps = {}) {
  const env = deps.env ?? process.env;
  const appendFile = deps.appendFileSync ?? appendFileSync;
  const write = deps.writeStream ?? ((s) => process.stdout.write(s));
  const flat = String(reason).replace(/\r?\n/g, ' ');
  if (env.GITHUB_OUTPUT) {
    appendFile(env.GITHUB_OUTPUT, `verdict=${verdict}\nreason=${flat}\n`);
  } else {
    write(`verdict=${verdict}\nreason=${flat}\n`);
  }
}

function createLineTail(limit) {
  const decoder = new StringDecoder('utf8');
  let lines = [];
  let partial = '';
  return {
    push(chunk) {
      const pieces = (partial + decoder.write(chunk)).split('\n');
      partial = pieces.pop() ?? '';
      lines.push(...pieces);
      if (lines.length > limit) lines = lines.slice(-limit);
    },
    lines() {
      return partial ? [...lines, partial].slice(-limit) : [...lines];
    },
  };
}

function parseProgressLine(line) {
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object'
      ? event
      : { kind: 'unparsed', raw: line.slice(0, 200) };
  } catch {
    return { kind: 'unparsed', raw: line.slice(0, 200) };
  }
}

async function readNewProgress(progress) {
  let handle;
  try {
    handle = await open(progress.file, 'r');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size <= progress.offset) return [];
    const buffer = Buffer.alloc(size - progress.offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, progress.offset);
    progress.offset += bytesRead;
    const pieces = (progress.partial + progress.decoder.write(buffer.subarray(0, bytesRead))).split(
      '\n',
    );
    progress.partial = pieces.pop() ?? '';
    return pieces.filter((line) => line.trim() !== '').map(parseProgressLine);
  } finally {
    await handle.close();
  }
}

function cancellableDelay(ms) {
  let timer;
  const promise = new Promise((resolvePromise) => {
    timer = setTimeout(resolvePromise, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function settleWithin(promise, ms) {
  const delay = cancellableDelay(ms);
  try {
    return await Promise.race([promise, delay.promise.then(() => null)]);
  } finally {
    delay.cancel();
  }
}

function childIsRunning(child) {
  return typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null;
}

export function signalHeldGroup(child, signal, send) {
  if (!childIsRunning(child)) return { sent: false, reason: 'the runner had already exited' };
  try {
    send(child, signal);
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err?.message ?? String(err) };
  }
}

const sendToHeldGroup = (child, signal) => {
  process.kill(-child.pid, signal);
};

export async function runBoundedCommand(command, args, boundMs, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  let child;
  try {
    child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { error: err?.message ?? String(err), stdout: '', stderr: '' };
  }
  const chunks = { stdout: [], stderr: [] };
  let captured = 0;
  const collect = (name) => (chunk) => {
    if (captured >= DIAGNOSTIC_OUTPUT_CAP_BYTES) return;
    captured += chunk.length;
    chunks[name].push(chunk);
  };
  child.stdout?.on('data', collect('stdout'));
  child.stderr?.on('data', collect('stderr'));
  const finished = new Promise((resolvePromise) => {
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
    child.once('error', (err) => resolvePromise({ error: err?.message ?? String(err) }));
  });
  const outcome = await settleWithin(finished, boundMs);
  const text = (name) => Buffer.concat(chunks[name]).toString('utf8');
  if (outcome === null) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    return { timedOut: true, stdout: text('stdout'), stderr: text('stderr') };
  }
  return { ...outcome, stdout: text('stdout'), stderr: text('stderr') };
}

export function renderProcessTree(table, rootPid) {
  const rows = table
    .split('\n')
    .slice(1)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), line: line.trim() } : null;
    })
    .filter(Boolean);
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const out = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    for (const row of children.get(pid) ?? []) {
      if (seen.has(row.pid)) continue;
      seen.add(row.pid);
      out.push(`${'  '.repeat(depth)}${row.line}`);
      walk(row.pid, depth + 1);
    }
  };
  const root = rows.find((row) => row.pid === rootPid);
  if (root) {
    seen.add(root.pid);
    out.push(root.line);
  }
  walk(rootPid, root ? 1 : 0);
  return out;
}

function describeCommandOutcome(outcome, boundMs) {
  if (outcome.error) return `could not run: ${outcome.error}`;
  if (outcome.timedOut) {
    return `did not finish within ${formatDuration(boundMs)}; left running, output so far is above`;
  }
  if (outcome.code !== 0)
    return `exited ${outcome.code ?? outcome.signal}: ${outcome.stderr.trim()}`;
  return null;
}

export async function collectStallDiagnostics({
  stall,
  outputTail,
  log,
  boundMs,
  rootPid = process.pid,
  platform = process.platform,
  runBounded = runBoundedCommand,
}) {
  log('::group::DMG smoke stall: the last Playwright progress events');
  for (const event of stall.recent) log(`  ${describeProgressEvent(event)}`);
  log('::endgroup::');

  log(`::group::DMG smoke stall: the last ${outputTail.length} lines of Playwright output`);
  for (const line of outputTail) log(`  ${clipLine(line)}`);
  log('::endgroup::');

  log(`::group::DMG smoke stall: processes (${PROCESS_TABLE_COLUMNS})`);
  const ps = await runBounded('ps', ['-A', '-ww', '-o', PROCESS_TABLE_COLUMNS], boundMs);
  const psProblem = describeCommandOutcome(ps, boundMs);
  if (ps.stdout) {
    log(`The smoke driver (pid ${rootPid}) and everything under it:`);
    for (const line of renderProcessTree(ps.stdout, rootPid)) log(`  ${clipLine(line)}`);
    log('Every process:');
    for (const line of ps.stdout.trimEnd().split('\n')) log(`  ${clipLine(line)}`);
  }
  if (psProblem) log(`ps ${psProblem}`);
  log('::endgroup::');

  if (platform === 'darwin') {
    log('::group::DMG smoke stall: on-screen windows (owner pid, layer, owner, title)');
    const windows = await runBounded(
      'osascript',
      ['-l', 'JavaScript', '-e', ON_SCREEN_WINDOWS_JXA],
      boundMs,
    );
    if (windows.stdout) {
      for (const line of windows.stdout.trimEnd().split('\n')) log(`  ${clipLine(line)}`);
    }
    const windowsProblem = describeCommandOutcome(windows, boundMs);
    if (windowsProblem) log(`the window listing ${windowsProblem}`);
    log('::endgroup::');
  }
}

export async function runWatchedPlaywright({
  command,
  args,
  cwd,
  env,
  watchdog = WATCHDOG,
  out = (chunk) => process.stdout.write(chunk),
  err = (chunk) => process.stderr.write(chunk),
  log = (line) => process.stdout.write(`${line}\n`),
  now = () => Date.now(),
  spawnImpl = spawn,
  sendGroupSignal = sendToHeldGroup,
  diagnose = collectStallDiagnostics,
  signalSource = process,
}) {
  const settings = { ...WATCHDOG, ...watchdog };
  const progressDir = await mkdtemp(join(tmpdir(), 'ok-smoke-progress-'));
  const progress = {
    file: join(progressDir, 'progress.jsonl'),
    offset: 0,
    decoder: new StringDecoder('utf8'),
    partial: '',
    recent: [],
    lastAt: null,
  };
  const outputTail = createLineTail(OUTPUT_TAIL_LINES);

  let child;
  try {
    child = spawnImpl(command, args, {
      cwd,
      env: { ...env, [PROGRESS_FILE_ENV]: progress.file, [PLAYWRIGHT_REPORTER_ENV]: SCRIPT_PATH },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnError) {
    await rm(progressDir, { recursive: true, force: true });
    return { exitCode: 1, runnerError: spawnError?.message ?? String(spawnError), stall: null };
  }

  const exited = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    child.once('error', (error) => resolvePromise({ code: null, signal: null, error }));
  });
  const closed = new Promise((resolvePromise) => child.once('close', resolvePromise));
  child.stdout?.on('data', (chunk) => {
    out(chunk);
    outputTail.push(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    err(chunk);
    outputTail.push(chunk);
  });

  const forwarders = ['SIGINT', 'SIGTERM'].map((signal) => {
    const forward = () => {
      signalHeldGroup(child, signal, sendGroupSignal);
    };
    signalSource.on(signal, forward);
    return () => signalSource.off(signal, forward);
  });

  const dumpDiagnostics = async (stallState) => {
    try {
      await diagnose({
        stall: stallState,
        outputTail: outputTail.lines(),
        log,
        boundMs: settings.diagnosticBoundMs,
      });
    } catch (diagnosticError) {
      log(`The stall diagnostics failed: ${diagnosticError?.message ?? String(diagnosticError)}`);
    }
  };

  const startedAt = now();
  let windowMs = settings.stallWindowMs;
  let warnedUnarmed = false;
  let progressUnreadable = false;
  let stall = null;
  let settled = null;
  try {
    while (settled === null) {
      const tick = cancellableDelay(settings.pollMs);
      settled = await Promise.race([exited, tick.promise.then(() => null)]);
      tick.cancel();
      if (settled !== null) break;
      if (progressUnreadable) continue;

      let events = [];
      try {
        events = await readNewProgress(progress);
      } catch (readError) {
        progressUnreadable = true;
        log(
          `::warning::The DMG smoke's progress file became unreadable (${readError?.message ?? String(readError)}), so the no-progress watchdog stands down; only the step's timeout bounds this run.`,
        );
        continue;
      }
      if (events.length > 0) {
        if (progress.lastAt === null) {
          log(
            `DMG smoke watchdog: the progress reporter is connected; the run is stopped after ${formatDuration(windowMs)} without progress.`,
          );
        }
        progress.lastAt = now();
        progress.recent = [...progress.recent, ...events].slice(-RECENT_EVENTS_KEPT);
        const testTimeoutMs = Math.max(
          0,
          ...events
            .filter((event) => event.kind === 'begin')
            .map((event) => event.testTimeoutMs ?? 0),
        );
        const derivedWindowMs = settings.stallWindowTestTimeouts * testTimeoutMs;
        if (derivedWindowMs > windowMs) {
          windowMs = derivedWindowMs;
          log(
            `DMG smoke watchdog: the window is now ${formatDuration(windowMs)}, ${settings.stallWindowTestTimeouts} times the run's ${formatDuration(testTimeoutMs)} per-test timeout.`,
          );
        }
      }
      const at = now();
      if (progress.lastAt === null) {
        if (!warnedUnarmed && at - startedAt >= windowMs) {
          warnedUnarmed = true;
          log(
            `::warning::The DMG smoke's progress reporter has not reported in ${formatDuration(at - startedAt)}, so the no-progress watchdog cannot see this run; only the step's timeout bounds it. Dumping diagnostics once; the run is left running.`,
          );
          await dumpDiagnostics({ silentMs: at - startedAt, windowMs, recent: progress.recent });
        }
        continue;
      }
      if (at - progress.lastAt >= windowMs) {
        stall = { silentMs: at - progress.lastAt, windowMs, recent: progress.recent };
        break;
      }
    }

    if (stall) {
      log(
        `::warning::DMG smoke stalled: no Playwright progress for ${formatDuration(stall.silentMs)} (window ${formatDuration(stall.windowMs)}). Last progress: ${describeProgressEvent(stall.recent.at(-1))}. Dumping diagnostics, then stopping the run.`,
      );
      await dumpDiagnostics(stall);
      let lastSent = null;
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        const attempt = signalHeldGroup(child, signal, sendGroupSignal);
        if (!attempt.sent) {
          log(
            `Did not send ${signal} to the Playwright runner's process group: ${attempt.reason}.`,
          );
          break;
        }
        lastSent = signal;
        log(`Sent ${signal} to the Playwright runner's process group (${child.pid}).`);
        settled = await settleWithin(exited, settings.stopGraceMs);
        if (settled !== null) break;
      }
      if (settled === null && lastSent !== 'SIGKILL') {
        settled = await settleWithin(exited, settings.stopGraceMs);
      }
      if (settled === null) {
        log(
          `The Playwright runner (${child.pid}) had not exited ${formatDuration(settings.stopGraceMs)} after ${lastSent ?? 'the stall'}; leaving it.`,
        );
      }
    }
  } finally {
    for (const remove of forwarders) remove();
    await settleWithin(closed, settings.drainMs);
    child.stdout?.destroy();
    child.stderr?.destroy();
    await rm(progressDir, { recursive: true, force: true }).catch((cleanupError) => {
      log(`Could not remove ${progressDir}: ${cleanupError?.message ?? String(cleanupError)}`);
    });
  }

  if (settled?.error) {
    return {
      exitCode: 1,
      runnerError: settled.error.message ?? String(settled.error),
      stall,
    };
  }
  return { exitCode: settled?.code ?? 1, signal: settled?.signal ?? null, stall };
}

async function defaultRunPlaywright(appPath, deps = {}) {
  return await runWatchedPlaywright({
    command: 'pnpm',
    args: ['exec', 'playwright', 'test', '--config', PACKAGED_CONFIG],
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      OK_DESKTOP_PACKAGED_APP: appPath,
      OK_DESKTOP_E2E_SMOKE: '1',
    },
    spawnImpl: deps.spawn ?? spawn,
  });
}

async function defaultReadReport(deps = {}) {
  const warn = deps.warn ?? ((msg) => process.stderr.write(`[smoke-packaged-dmg] ${msg}\n`));
  try {
    return JSON.parse(await readFile(join(DESKTOP_DIR, PACKAGED_REPORT), 'utf-8'));
  } catch (err) {
    warn(`could not read ${PACKAGED_REPORT}: ${err?.message ?? String(err)}`);
    return null;
  }
}

export async function smokePackagedDmg(dmgPath, deps = {}) {
  const withMount = deps.withMountedDmg ?? withMountedDmg;
  const runPlaywright = deps.runPlaywright ?? ((appPath) => defaultRunPlaywright(appPath, deps));
  const readReport = deps.readReport ?? (() => defaultReadReport(deps));

  try {
    return await withMount(
      dmgPath,
      async (appPath) => {
        const { exitCode, signal, runnerError, stall } = await runPlaywright(appPath);
        const report = stall ? null : await readReport(appPath);
        return classifyRun({
          runExitCode: exitCode,
          runSignal: signal,
          report,
          runnerError,
          stall,
        });
      },
      deps,
    );
  } catch (err) {
    return {
      verdict: VERDICT.error,
      reason: `could not prepare the DMG for smoking: ${err?.message ?? String(err)}`,
    };
  }
}

export async function runDriver(argv, deps = {}) {
  const errStream = deps.errStream ?? ((s) => process.stderr.write(s));
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`));

  const dmgPath = argv.slice(2).find((a) => !a.startsWith('-'));
  if (!dmgPath) {
    errStream('usage: smoke-packaged-dmg.mjs <path-to.dmg>\n');
    return EXIT_CODES[VERDICT.error];
  }

  const result = await smokePackagedDmg(dmgPath, deps);
  log(annotationFor(result.verdict, result.reason, dmgPath));
  publishVerdict(result, deps);
  return EXIT_CODES[result.verdict];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDriver(process.argv).then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), EXIT_FLUSH_BOUND_MS).unref();
  });
}
