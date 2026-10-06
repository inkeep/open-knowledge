import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DmgMountError, MOUNT_ERROR_CODES } from './dmg-mount.mjs';
import { selectPromotion } from './select-beta-to-promote.mjs';
import {
  annotationFor,
  classifyRun,
  EXIT_CODES,
  PROGRESS_FILE_ENV,
  publishVerdict,
  renderProcessTree,
  runBoundedCommand,
  runDriver,
  runWatchedPlaywright,
  smokePackagedDmg,
  stallReason,
  VERDICT,
} from './smoke-packaged-dmg.mjs';

const report = (stats) => ({ stats });

const mountOk = async (_dmg, cb) => cb('/tmp/copy/OpenKnowledge.app');
const mountThrows = (err) => async () => {
  throw err;
};

function deps({ mount = mountOk, run, read }) {
  return {
    withMountedDmg: mount,
    runPlaywright: run ?? (async () => ({ exitCode: 0 })),
    readReport: read ?? (async () => report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 })),
  };
}

describe('classifyRun', () => {
  test('all executed tests passing is a pass', () => {
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 16, unexpected: 0, flaky: 0, skipped: 2 }),
    });
    expect(v.verdict).toBe(VERDICT.pass);
    expect(v.reason).toContain('16');
  });

  test('a genuine test failure is a fail, not an error', () => {
    const v = classifyRun({
      runExitCode: 1,
      report: report({ expected: 14, unexpected: 2, flaky: 0, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.fail);
    expect(v.reason).toContain('2 of 16');
  });

  test('flaky-but-eventually-green counts as executed and passes', () => {
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 15, unexpected: 0, flaky: 1, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.pass);
  });

  test('zero executed tests is an error, never a pass', () => {
    const v = classifyRun({
      runExitCode: 0,
      report: report({ expected: 0, unexpected: 0, flaky: 0, skipped: 16 }),
    });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.verdict).not.toBe(VERDICT.pass);
    expect(v.reason).toContain('16 skipped');
  });

  test('a missing or unparseable report is an error', () => {
    expect(classifyRun({ runExitCode: 0, report: null }).verdict).toBe(VERDICT.error);
    expect(classifyRun({ runExitCode: 1, report: undefined }).verdict).toBe(VERDICT.error);
  });

  test('a runner that would not start is an error, not a fail', () => {
    const v = classifyRun({ runExitCode: 1, report: null, runnerError: 'spawn pnpm ENOENT' });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('ENOENT');
  });

  test('a non-zero exit with no failing test is an error, not a fail', () => {
    const v = classifyRun({
      runExitCode: 3,
      report: report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 }),
    });
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('exited 3');
  });
});

describe('annotationFor', () => {
  test('pass is a notice; fail and error are warnings and read differently', () => {
    const pass = annotationFor(VERDICT.pass, 'r', '/a.dmg');
    const fail = annotationFor(VERDICT.fail, 'r', '/a.dmg');
    const error = annotationFor(VERDICT.error, 'r', '/a.dmg');
    expect(pass.startsWith('::notice::')).toBe(true);
    expect(fail.startsWith('::warning::')).toBe(true);
    expect(error.startsWith('::warning::')).toBe(true);
    expect(fail).not.toBe(error);
    expect(fail).toContain('FAILED');
    expect(error).toContain('ERRORED');
    expect(error).toContain('infrastructure');
    expect(fail).not.toContain('ERRORED');
  });
});

describe('publishVerdict', () => {
  test('writes verdict and reason to the step-output file when present', () => {
    const writes = [];
    publishVerdict(
      { verdict: VERDICT.fail, reason: 'two tests failed' },
      {
        env: { GITHUB_OUTPUT: '/tmp/out.txt' },
        appendFileSync: (p, s) => writes.push([p, s]),
      },
    );
    expect(writes).toEqual([['/tmp/out.txt', 'verdict=fail\nreason=two tests failed\n']]);
  });

  test('flattens newlines so the key=value format cannot be corrupted', () => {
    const writes = [];
    publishVerdict(
      { verdict: VERDICT.error, reason: 'line one\nline two' },
      { env: { GITHUB_OUTPUT: '/tmp/out.txt' }, appendFileSync: (_p, s) => writes.push(s) },
    );
    expect(writes[0]).toBe('verdict=error\nreason=line one line two\n');
  });

  test('echoes to stdout when there is no step-output file', () => {
    const out = [];
    publishVerdict(
      { verdict: VERDICT.pass, reason: 'ok' },
      { env: {}, writeStream: (s) => out.push(s) },
    );
    expect(out.join('')).toBe('verdict=pass\nreason=ok\n');
  });
});

describe('smokePackagedDmg', () => {
  test('passes the copied app path to the runner', async () => {
    let seen = null;
    const v = await smokePackagedDmg(
      '/tmp/OpenKnowledge.dmg',
      deps({
        run: async (appPath) => {
          seen = appPath;
          return { exitCode: 0 };
        },
      }),
    );
    expect(seen).toBe('/tmp/copy/OpenKnowledge.app');
    expect(v.verdict).toBe(VERDICT.pass);
  });

  test('a mount failure becomes an error verdict rather than throwing', async () => {
    const v = await smokePackagedDmg(
      '/tmp/broken.dmg',
      deps({
        mount: mountThrows(
          new DmgMountError(
            'hdiutil attach failed: no mountable file systems',
            MOUNT_ERROR_CODES.attachFailed,
          ),
        ),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('no mountable file systems');
  });

  test('a DMG with no .app inside becomes an error verdict', async () => {
    const v = await smokePackagedDmg(
      '/tmp/empty.dmg',
      deps({
        mount: mountThrows(
          new DmgMountError('No .app bundle found in mounted DMG', MOUNT_ERROR_CODES.noAppBundle),
        ),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('No .app bundle');
  });

  test('a wholly-skipped run against a broken DMG is an error', async () => {
    const v = await smokePackagedDmg(
      '/tmp/broken.dmg',
      deps({
        run: async () => ({ exitCode: 0 }),
        read: async () => report({ expected: 0, unexpected: 0, flaky: 0, skipped: 16 }),
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
  });

  test('a missing report is an error', async () => {
    const v = await smokePackagedDmg('/tmp/OpenKnowledge.dmg', deps({ read: async () => null }));
    expect(v.verdict).toBe(VERDICT.error);
  });

  test('a runner ended by a signal and leaving no report is an error that names the signal', async () => {
    const v = await smokePackagedDmg(
      '/tmp/OpenKnowledge.dmg',
      deps({
        run: async () => ({ exitCode: 1, signal: 'SIGKILL', stall: null }),
        read: async () => null,
      }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('report was missing or unparseable');
    expect(v.reason).toContain('ended by SIGKILL');
  });

  test('a runner ended by a signal with no failing test is an error that names the signal, not an exit code', async () => {
    const v = await smokePackagedDmg(
      '/tmp/OpenKnowledge.dmg',
      deps({ run: async () => ({ exitCode: 1, signal: 'SIGTERM', stall: null }) }),
    );
    expect(v.verdict).toBe(VERDICT.error);
    expect(v.reason).toContain('with no failing test');
    expect(v.reason).toContain('ended by SIGTERM');
    expect(v.reason).not.toContain('exited 1');
  });
});

describe('runDriver', () => {
  function driverDeps(over) {
    const lines = [];
    const outputs = [];
    return {
      lines,
      outputs,
      deps: {
        ...deps(over ?? {}),
        log: (s) => lines.push(s),
        errStream: (s) => lines.push(s),
        env: { GITHUB_OUTPUT: '/tmp/out.txt' },
        appendFileSync: (_p, s) => outputs.push(s),
      },
    };
  }

  test('exits 0 and annotates on pass', async () => {
    const { lines, outputs, deps: d } = driverDeps();
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).toBe(0);
    expect(lines[0]).toContain('::notice::');
    expect(outputs[0]).toContain('verdict=pass');
  });

  test('exits non-zero on fail so a step that forgets to branch still fails closed', async () => {
    const { outputs, deps: d } = driverDeps({
      run: async () => ({ exitCode: 1 }),
      read: async () => report({ expected: 14, unexpected: 2, flaky: 0, skipped: 0 }),
    });
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).not.toBe(0);
    expect(code).toBe(EXIT_CODES[VERDICT.fail]);
    expect(outputs[0]).toContain('verdict=fail');
  });

  test('exits non-zero on error, with a code distinct from fail', async () => {
    const { deps: d } = driverDeps({ read: async () => null });
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], d);
    expect(code).toBe(EXIT_CODES[VERDICT.error]);
    expect(EXIT_CODES[VERDICT.error]).not.toBe(EXIT_CODES[VERDICT.fail]);
  });

  test('a missing argument is an error, not a silent pass', async () => {
    const { deps: d } = driverDeps();
    expect(await runDriver(['node', 'x'], d)).toBe(EXIT_CODES[VERDICT.error]);
  });
});

describe('defensive defaults are pinned, not incidental', () => {
  test('a report with no stats key is an error, not a pass', () => {
    expect(classifyRun({ runExitCode: 0, report: {} }).verdict).toBe(VERDICT.error);
  });

  test('a report with an empty stats object is an error, not a pass', () => {
    expect(classifyRun({ runExitCode: 0, report: { stats: {} } }).verdict).toBe(VERDICT.error);
  });

  test('a partial stats object still counts what is there', () => {
    expect(classifyRun({ runExitCode: 0, report: { stats: { expected: 3 } } }).verdict).toBe(
      VERDICT.pass,
    );
    expect(classifyRun({ runExitCode: 1, report: { stats: { unexpected: 1 } } }).verdict).toBe(
      VERDICT.fail,
    );
  });
});

const DRIVER_PATH = fileURLToPath(new URL('./smoke-packaged-dmg.mjs', import.meta.url));
const DESKTOP_DIR = resolve(dirname(DRIVER_PATH), '..', '..', 'packages', 'desktop');

const FAKE_RUNNER_SOURCE = `import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const [driverPath, grandchildPath, planJson] = process.argv.slice(2);
const plan = JSON.parse(planJson);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fakeTest = (n) => ({ titlePath: () => ['', '', 'fake.e2e.ts', 'fake test ' + n] });
const Reporter = (await import(pathToFileURL(driverPath).href)).default;
const reporter = plan.reporter === false ? null : new Reporter();
reporter?.onBegin({ projects: [{ timeout: plan.testTimeoutMs ?? 0 }] }, { allTests: () => [fakeTest(0)] });
process.stdout.write('fake runner started\\n');
for (const grandchild of plan.grandchildren ?? []) {
  spawn(process.execPath, [grandchildPath, ...grandchild.files], {
    detached: grandchild.detached,
    stdio: ['ignore', 'inherit', 'inherit'],
  }).unref();
}
for (let n = 0; n < plan.tests; n += 1) {
  await pause(plan.testMs);
  reporter?.onTestBegin(fakeTest(n), { retry: 0 });
  reporter?.onTestEnd(fakeTest(n), { retry: 0, status: 'passed', duration: plan.testMs });
  process.stdout.write('  ok ' + (n + 1) + ' fake.e2e.ts > fake test ' + n + '\\n');
}
await pause(plan.idleMs ?? 0);
if (plan.finish === 'stall') {
  process.stdout.write('fake runner: stalling\\n');
  setInterval(() => {}, 1 << 30);
  setTimeout(() => process.exit(0), 60_000);
} else {
  process.exitCode = plan.exitCode;
}
`;

const GRANDCHILD_SOURCE = `import { appendFileSync, existsSync } from 'node:fs';
const [heartbeatFile, releaseFile, signalFile] = process.argv.slice(2);
process.on('SIGTERM', () => {
  appendFileSync(signalFile, 'SIGTERM\\n');
  process.exit(0);
});
const startedAt = Date.now();
const beat = setInterval(() => {
  appendFileSync(heartbeatFile, 'beat\\n');
  if (existsSync(releaseFile) || Date.now() - startedAt > 60_000) {
    clearInterval(beat);
    process.exit(0);
  }
}, 20);
`;

const SCALED_WATCHDOG = {
  stallWindowMs: 1_500,
  stallWindowTestTimeouts: 4,
  pollMs: 50,
  stopGraceMs: 5_000,
  drainMs: 300,
  diagnosticBoundMs: 10_000,
};

let fixtures;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ok-smoke-watchdog-'));
  fixtures = {
    dir,
    runner: join(dir, 'fake-runner.mjs'),
    grandchild: join(dir, 'grandchild.mjs'),
  };
  await writeFile(fixtures.runner, FAKE_RUNNER_SOURCE);
  await writeFile(fixtures.grandchild, GRANDCHILD_SOURCE);
});

afterAll(async () => {
  await rm(fixtures.dir, { recursive: true, force: true });
});

async function waitFor(condition) {
  while (!condition()) await new Promise((done) => setTimeout(done, 20));
}

function beats(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').length - 1 : 0;
}

function watchFake(plan, over = {}) {
  const logs = [];
  const output = [];
  const sent = [];
  const spawned = [];
  const promise = runWatchedPlaywright({
    command: process.execPath,
    args: [fixtures.runner, DRIVER_PATH, fixtures.grandchild, JSON.stringify(plan)],
    cwd: fixtures.dir,
    env: { ...process.env },
    watchdog: SCALED_WATCHDOG,
    out: (chunk) => output.push(chunk.toString()),
    err: (chunk) => output.push(chunk.toString()),
    log: (line) => logs.push(line),
    spawnImpl: (...args) => {
      const child = spawn(...args);
      spawned.push(child);
      return child;
    },
    sendGroupSignal: (child, signal) => {
      sent.push({ pid: child.pid, signal });
      process.kill(-child.pid, signal);
    },
    signalSource: new EventEmitter(),
    ...over,
  });
  return { promise, logs, output, sent, spawned };
}

describe('the no-progress watchdog over real child processes', () => {
  test('a run that progresses and then stalls is stopped after a full window without progress, diagnostics first', async () => {
    const run = watchFake({ tests: 3, testMs: 30, finish: 'stall' });
    const result = await run.promise;
    const runnerPid = run.spawned[0].pid;

    expect(result.stall).not.toBeNull();
    expect(result.stall.silentMs).toBeGreaterThanOrEqual(SCALED_WATCHDOG.stallWindowMs);
    expect(result.stall.recent.at(-1)).toMatchObject({
      kind: 'test-end',
      test: 'fake.e2e.ts › fake test 2',
      status: 'passed',
    });
    expect(run.sent).toEqual([{ pid: runnerPid, signal: 'SIGTERM' }]);
    expect(result.signal).toBe('SIGTERM');

    const stalledAt = run.logs.findIndex((line) => line.includes('DMG smoke stalled'));
    const outputAt = run.logs.findIndex((line) => line.includes('fake runner: stalling'));
    const tableAt = run.logs.findIndex((line) => line.includes('Every process:'));
    const stoppedAt = run.logs.findIndex((line) => line.startsWith('Sent SIGTERM'));
    expect(stalledAt).toBeGreaterThan(-1);
    expect(outputAt).toBeGreaterThan(stalledAt);
    expect(tableAt).toBeGreaterThan(stalledAt);
    expect(stoppedAt).toBeGreaterThan(tableAt);
    expect(run.logs[tableAt + 1]).toMatch(/ELAPSED.*%CPU.*%MEM/);
    expect(run.logs.some((line) => line.trim().split(/\s+/)[0] === String(runnerPid))).toBe(true);
  });

  test('the window follows the per-test timeout the run reports, once four of them pass the floor', async () => {
    const run = watchFake({ tests: 1, testMs: 20, testTimeoutMs: 1_000, finish: 'stall' });
    const result = await run.promise;

    expect(result.stall).toMatchObject({ windowMs: 4_000 });
    expect(result.stall.silentMs).toBeGreaterThanOrEqual(4_000);
    expect(run.logs).toContain(
      "DMG smoke watchdog: the window is now 4s, 4 times the run's 1s per-test timeout.",
    );
    expect(run.sent).toEqual([{ pid: run.spawned[0].pid, signal: 'SIGTERM' }]);
  });

  test('a slow run that keeps advancing is never stopped, however long it runs in total', async () => {
    const startedAt = Date.now();
    const run = watchFake({ tests: 10, testMs: 300, finish: 'exit', exitCode: 0 });
    const result = await run.promise;

    expect(Date.now() - startedAt).toBeGreaterThan(SCALED_WATCHDOG.stallWindowMs);
    expect(result).toMatchObject({ exitCode: 0, stall: null });
    expect(run.sent).toEqual([]);
    expect(run.output.join('')).toContain('fake test 9');
  });

  test.each([0, 1, 3])('the runner exit code %i passes through untouched', async (exitCode) => {
    const run = watchFake({ tests: 2, testMs: 20, finish: 'exit', exitCode });
    const result = await run.promise;

    expect(result).toMatchObject({ exitCode, stall: null });
    expect(run.sent).toEqual([]);
  });

  test('the stop reaches only the held runner group: an attached descendant ends, a detached one keeps running and holds nothing up', async () => {
    const files = (name) =>
      ['beats', 'release', 'signal'].map((kind) => join(fixtures.dir, `${name}.${kind}`));
    const attached = files('attached');
    const detached = files('detached');
    const run = watchFake({
      tests: 1,
      testMs: 20,
      finish: 'stall',
      grandchildren: [
        { detached: false, files: attached },
        { detached: true, files: detached },
      ],
    });
    const result = await run.promise;
    const beatsAtReturn = beats(detached[0]);

    expect(result.stall).not.toBeNull();
    expect(run.sent).toEqual([{ pid: run.spawned[0].pid, signal: 'SIGTERM' }]);
    await waitFor(() => existsSync(attached[2]));
    await waitFor(() => beats(detached[0]) > beatsAtReturn);
    expect(existsSync(detached[2])).toBe(false);
    expect(existsSync(detached[1])).toBe(false);

    await writeFile(detached[1], 'release');
    await writeFile(attached[1], 'release');
  });

  test('a SIGINT or SIGTERM to the driver is forwarded to the held runner group while it runs', async () => {
    const source = new EventEmitter();
    const run = watchFake(
      { tests: 1, testMs: 20, finish: 'stall' },
      {
        signalSource: source,
        out: (chunk) => {
          if (chunk.toString().includes('fake runner started')) source.emit('SIGTERM');
        },
      },
    );
    const result = await run.promise;

    expect(result).toMatchObject({ stall: null, signal: 'SIGTERM' });
    expect(run.sent).toEqual([{ pid: run.spawned[0].pid, signal: 'SIGTERM' }]);
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(source.listenerCount('SIGINT')).toBe(0);
  });

  test('a run whose progress reporter never reports is not stopped, says the step timeout is its only bound, and prints the diagnostics once', async () => {
    const run = watchFake({
      reporter: false,
      tests: 0,
      idleMs: 2 * SCALED_WATCHDOG.stallWindowMs,
      finish: 'exit',
      exitCode: 0,
    });
    const result = await run.promise;

    expect(result).toMatchObject({ exitCode: 0, stall: null });
    expect(run.sent).toEqual([]);
    expect(run.logs.filter((line) => line.includes('has not reported'))).toHaveLength(1);
    const warnedAt = run.logs.findIndex((line) => line.includes('has not reported'));
    const tables = run.logs.flatMap((line, at) => (line === 'Every process:' ? [at] : []));
    expect(tables).toHaveLength(1);
    expect(tables[0]).toBeGreaterThan(warnedAt);
    expect(run.logs[tables[0] + 1]).toMatch(/ELAPSED.*%CPU.*%MEM/);
  });

  test('a stalled smoke publishes verdict=error and exits 2, which the fast tier reads as an infrastructure error', async () => {
    const outputs = [];
    const lines = [];
    let reportRead = false;
    const code = await runDriver(['node', 'x', '/tmp/OpenKnowledge.dmg'], {
      withMountedDmg: mountOk,
      runPlaywright: () => watchFake({ tests: 1, testMs: 20, finish: 'stall' }).promise,
      readReport: async () => {
        reportRead = true;
        return report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 });
      },
      log: (s) => lines.push(s),
      env: { GITHUB_OUTPUT: '/tmp/out.txt' },
      appendFileSync: (_p, s) => outputs.push(s),
    });

    expect(code).toBe(EXIT_CODES[VERDICT.error]);
    expect(reportRead).toBe(false);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatch(
      /^verdict=error\nreason=the smoke stalled: no Playwright progress for /,
    );
    expect(lines.at(-1)).toContain('DMG smoke ERRORED');

    const verdict = /^verdict=(\w+)$/m.exec(outputs[0])[1];
    const logs = [];
    const selection = selectPromotion({
      betaTags: ['v0.10.0-beta.6'],
      isAlreadyShipped: () => false,
      fetchReleaseMeta: () => ({
        isDraft: false,
        publishedAt: '2026-07-08T19:00:00Z',
        assets: [{ name: 'OpenKnowledge-universal.dmg' }, { name: 'beta-mac.yml' }],
      }),
      soakSeconds: 86400,
      nowMs: Date.parse('2026-07-08T20:00:00Z'),
      qualifiesForFastTier: () => true,
      smokeBeta: () => verdict,
      log: (m) => logs.push(m),
    });
    expect(selection).toEqual({ kind: 'none' });
    expect(logs.join('\n')).toContain('infrastructure error and never reached a verdict');
  });
});

describe('the stall diagnostics never wait on a diagnostic', () => {
  test('a diagnostic command that outlives its bound is abandoned there, unsignalled', async () => {
    const finished = join(fixtures.dir, 'slow-diagnostic.finished');
    const script = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(finished)}, 'x'), 3000);`;
    const outcome = await runBoundedCommand(process.execPath, ['-e', script], 200);

    expect(outcome.timedOut).toBe(true);
    expect(existsSync(finished)).toBe(false);
  });

  test('the process tree lists the driver and its descendants only, indented by depth', () => {
    const table = [
      '  PID  PPID  PGID ELAPSED %CPU %MEM   RSS STAT COMMAND',
      '    1     0     1 01:00:00  0.0  0.1  1000 Ss   /sbin/launchd',
      '  100     1   100   05:00  0.1  0.2  2000 S    node smoke-packaged-dmg.mjs',
      '  200   100   200   04:00  1.0  1.0  3000 S    pnpm exec playwright test',
      '  300   200   200   03:59 50.0  4.0  9000 R    node playwright test',
      '  400     1   400   03:00  0.0  0.3  4000 S    unrelated',
    ].join('\n');

    expect(renderProcessTree(table, 100)).toEqual([
      '100     1   100   05:00  0.1  0.2  2000 S    node smoke-packaged-dmg.mjs',
      '  200   100   200   04:00  1.0  1.0  3000 S    pnpm exec playwright test',
      '    300   200   200   03:59 50.0  4.0  9000 R    node playwright test',
    ]);
  });

  test('a stall verdict names the stall, its window and the last progress', () => {
    const verdict = classifyRun({
      runExitCode: null,
      report: report({ expected: 16, unexpected: 0, flaky: 0, skipped: 0 }),
      stall: {
        silentMs: 601_000,
        windowMs: 600_000,
        recent: [
          {
            kind: 'test-begin',
            test: 'consent-dialog.e2e.ts › starts',
            at: '2026-10-06T13:30:00Z',
          },
        ],
      },
    });

    expect(verdict.verdict).toBe(VERDICT.error);
    expect(verdict.reason).toBe(
      stallReason({
        silentMs: 601_000,
        windowMs: 600_000,
        recent: [
          {
            kind: 'test-begin',
            test: 'consent-dialog.e2e.ts › starts',
            at: '2026-10-06T13:30:00Z',
          },
        ],
      }),
    );
    expect(verdict.reason).toContain('no Playwright progress for 10m01s (watchdog window 10m00s)');
    expect(verdict.reason).toContain(
      'test-begin "consent-dialog.e2e.ts › starts" at 2026-10-06T13:30:00Z',
    );
  });
});

describe('the progress reporter against the installed Playwright', () => {
  test('a real run reports progress through PW_TEST_REPORTER, and a hung test is stopped once the window passes', async () => {
    const desktopRequire = createRequire(join(DESKTOP_DIR, 'package.json'));
    const cli = desktopRequire.resolve('@playwright/test/cli');
    const dir = await mkdtemp(join(tmpdir(), 'ok-smoke-real-playwright-'));
    try {
      const config = join(dir, 'playwright.config.mjs');
      await writeFile(
        config,
        "export default { testDir: '.', testMatch: '**/*.e2e.mjs', timeout: 0, retries: 0, workers: 1, reporter: [['list']] };\n",
      );
      await writeFile(
        join(dir, 'stall.e2e.mjs'),
        [
          "import { createRequire } from 'node:module';",
          `const { test } = createRequire(${JSON.stringify(join(DESKTOP_DIR, 'package.json'))})('@playwright/test');`,
          "test('advances', async () => { await test.step('a step that finishes', async () => {}); });",
          "test('hangs', async () => { await test.step('a step that hangs', async () => { await new Promise(() => {}); }); });",
          '',
        ].join('\n'),
      );
      const logs = [];
      const sent = [];
      const result = await runWatchedPlaywright({
        command: process.execPath,
        args: [cli, 'test', '--config', config],
        cwd: dir,
        env: { ...process.env },
        watchdog: { ...SCALED_WATCHDOG, stallWindowMs: 6_000 },
        out: () => {},
        err: () => {},
        log: (line) => logs.push(line),
        sendGroupSignal: (child, signal) => {
          sent.push(signal);
          process.kill(-child.pid, signal);
        },
        signalSource: new EventEmitter(),
        diagnose: async () => {},
      });

      expect(logs.some((line) => line.includes('progress reporter is connected'))).toBe(true);
      expect(result.stall).not.toBeNull();
      expect(result.stall.recent.at(-1)).toMatchObject({
        kind: 'step-begin',
        test: expect.stringContaining('hangs'),
        step: 'a step that hangs',
      });
      expect(result.stall.recent).toContainEqual(
        expect.objectContaining({ kind: 'test-begin', test: expect.stringContaining('hangs') }),
      );
      expect(sent[0]).toBe('SIGTERM');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function runReporterInChild(progressFile) {
  const plan = { tests: 3, testMs: 0, finish: 'exit', exitCode: 0 };
  const child = spawn(
    process.execPath,
    [fixtures.runner, DRIVER_PATH, fixtures.grandchild, JSON.stringify(plan)],
    {
      cwd: fixtures.dir,
      env: { ...process.env, [PROGRESS_FILE_ENV]: progressFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((done) => child.on('close', done));
  return { exitCode, stderr };
}

describe('a progress file the reporter cannot write is said in the runner output', () => {
  test('every append failing yields one stderr line that names the file and the error', async () => {
    const progressFile = join(fixtures.dir, 'no-such-dir', 'progress.jsonl');
    const run = await runReporterInChild(progressFile);

    expect(run.exitCode).toBe(0);
    expect(existsSync(progressFile)).toBe(false);
    const lines = run.stderr.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[smoke-packaged-dmg\] /);
    expect(lines[0]).toContain(progressFile);
    expect(lines[0]).toContain('ENOENT');
  });

  test('a reporter whose appends succeed writes nothing to stderr', async () => {
    const progressFile = join(fixtures.dir, 'writable-progress.jsonl');
    const run = await runReporterInChild(progressFile);

    expect(run.exitCode).toBe(0);
    const kinds = readFileSync(progressFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).kind);
    expect(kinds).toContain('ready');
    expect(kinds).toContain('test-end');
    expect(run.stderr).toBe('');
  });
});
