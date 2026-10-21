import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const child = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => child);

import { readPtyPhaseRecords } from './pty-phase-evidence.mjs';
import { runWindowsPackageTerminalSmoke } from './smoke-windows-terminal-package.mjs';

const fixtures = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each([0, 1])(
  'preserves the packaged observation files before cleanup when the driver exits %i',
  (status) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-'));
    fixtures.push(root);
    const packageDir = join(root, 'package');
    const diagnosticsDir = join(root, 'evidence');
    const logDir = join(root, 'desktop-logs');
    mkdirSync(packageDir);
    mkdirSync(logDir);
    writeFileSync(join(packageDir, 'OpenKnowledge.exe'), 'fixture');
    let profile;
    const driverOutput = `driver output\n${JSON.stringify({
      event: 'pty-phase',
      producer: 'renderer',
      phase: 'start',
      edge: 'begin',
      sequence: 1,
      atMs: 0,
      ptyId: 'echo-session',
    })}\n`;
    child.spawn.mockImplementation((_file, args, options) => {
      profile = args
        .find((arg) => arg.startsWith('--user-data-dir='))
        .slice('--user-data-dir='.length);
      writeFileSync(join(profile, 'bug-report-main-thread-liveness.json'), '{"lastAck":1}');
      const record = {
        event: 'pty-phase',
        producer: 'main',
        pid: 12345,
        sequence: 1,
        atMs: 0,
        wallTimeMs: Date.now(),
        phase: 'paths',
        edge: 'point',
        userDataDir: profile,
        logDir,
      };
      writeFileSync(join(logDir, 'desktop.log'), `${JSON.stringify(record)}\n{"event":"boot"}\n`);
      writeSync(options.stdio[1], `${JSON.stringify(record)}\napp output\n`);
      return { pid: 12345 };
    });
    child.spawnSync.mockImplementation((file) =>
      file === 'taskkill'
        ? { status: 0 }
        : { status, stdout: driverOutput, stderr: status ? 'original echo failure' : '' },
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const run = () =>
      runWindowsPackageTerminalSmoke({
        packageDir,
        diagnosticsDir,
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      });
    if (status) expect(run).toThrow('packaged PTY CDP driver exited 1 (signal undefined)');
    else expect(run).toThrow('Packaged PTY phase evidence is missing the utility session');
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(diagnosticsDir), 'the uploaded evidence must survive fixture deletion').toBe(
      true,
    );
    const saved = join(diagnosticsDir, readdirSync(diagnosticsDir)[0]);
    expect(readFileSync(join(saved, 'app-stdio.log'), 'utf8')).toContain('app output');
    expect(readFileSync(join(saved, 'desktop-logs', 'desktop.log'), 'utf8')).toContain(
      '"event":"boot"',
    );
    expect(
      readFileSync(join(saved, 'user-data', 'bug-report-main-thread-liveness.json'), 'utf8'),
    ).toBe('{"lastAck":1}');
    expect(readFileSync(join(saved, 'driver.stdout.log'), 'utf8')).toBe(driverOutput);
    expect(readFileSync(join(saved, 'driver.stderr.log'), 'utf8')).toBe(
      status ? 'original echo failure' : '',
    );
    expect(JSON.parse(readFileSync(join(saved, 'manifest.json'), 'utf8')).driver.status).toBe(
      status,
    );
  },
);

test.each([0, 1])(
  'reports driver outcome %i without accepting evidence that could not be saved',
  (status) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-error-'));
    fixtures.push(root);
    writeFileSync(join(root, 'OpenKnowledge.exe'), 'fixture');
    const diagnosticsDir = join(root, 'file-instead-of-directory');
    writeFileSync(diagnosticsDir, 'occupied');
    child.spawn.mockReturnValue({ pid: undefined });
    child.spawnSync.mockReturnValue({ status, signal: null, stdout: '', stderr: '' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const run = () =>
      runWindowsPackageTerminalSmoke({
        packageDir: root,
        diagnosticsDir,
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      });
    if (status) expect(run).toThrow('packaged PTY CDP driver exited 1 (signal null)');
    else expect(run).toThrow('Packaged PTY phase evidence was not preserved');
    expect(warning.mock.calls.flat().join('\n')).toContain(
      'Could not preserve packaged PTY diagnostics',
    );
    expect(readFileSync(diagnosticsDir, 'utf8')).toBe('occupied');
  },
);

test('reports verified retained utility phases after a successful packaged echo', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-complete-'));
  fixtures.push(root);
  const diagnosticsDir = join(root, 'evidence');
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  writeFileSync(join(root, 'OpenKnowledge.exe'), 'fixture');
  const ptyId = 'echo-session';
  const startup = [
    ['utility-entry', 'point'],
    ['module-entry', 'point'],
    ['logger-import', 'begin'],
    ['logger-import', 'end'],
    ['native-import', 'begin'],
    ['native-import', 'end'],
    ['listener-ready', 'point'],
  ].map(([phase, edge]) => ({ phase, edge }));
  const session = [
    ['message-received', 'point'],
    ['shell-resolution', 'begin'],
    ['shell-resolution', 'end'],
    ['pty-spawn', 'begin'],
    ['pty-spawn', 'end'],
    ['pty-first-output', 'point'],
    ['pty-first-forward', 'point'],
  ].map(([phase, edge]) => ({ phase, edge, ptyId, currentSession: true }));
  const utility = [...startup, ...session].map((record, index) => ({
    event: 'pty-phase',
    producer: 'utility',
    pid: 42,
    sequence: index + 1,
    atMs: index,
    timeOriginMs: 100,
    ...record,
  }));
  const mainRelay = ['utility-data-received', 'main-data-relay', 'main-data-relay'].map(
    (phase, index) => ({
      event: 'pty-phase',
      producer: 'main',
      pid: 12345,
      sequence: index + 2,
      atMs: index + 1,
      timeOriginMs: 100,
      phase,
      edge: phase === 'main-data-relay' ? (index === 1 ? 'begin' : 'end') : 'point',
      ptyId,
      ...(phase === 'main-data-relay' && index === 2 ? { ok: true } : {}),
    }),
  );
  child.spawn.mockImplementation((_file, args, options) => {
    const profile = args.find((arg) => arg.startsWith('--user-data-dir=')).slice(16);
    const paths = {
      event: 'pty-phase',
      producer: 'main',
      pid: 12345,
      sequence: 1,
      atMs: 0,
      wallTimeMs: Date.now(),
      phase: 'paths',
      edge: 'point',
      userDataDir: profile,
      logDir,
    };
    writeFileSync(join(logDir, 'desktop.log'), `${JSON.stringify(paths)}\n`);
    writeSync(
      options.stdio[1],
      [paths, ...mainRelay, ...utility].map((r) => JSON.stringify(r)).join('\n'),
    );
    return { pid: 12345 };
  });
  child.spawnSync.mockImplementation((file) => ({
    status: 0,
    stdout:
      file === 'taskkill'
        ? ''
        : JSON.stringify({
            event: 'pty-phase',
            producer: 'renderer',
            sequence: 1,
            atMs: 0,
            phase: 'start',
            edge: 'begin',
            ptyId,
          }) +
          '\n' +
          JSON.stringify({
            event: 'pty-phase',
            producer: 'renderer',
            sequence: 2,
            atMs: 1,
            phase: 'renderer-data-received',
            edge: 'point',
            ptyId,
          }),
    stderr: '',
  }));
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  runWindowsPackageTerminalSmoke({
    packageDir: root,
    diagnosticsDir,
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });
  const saved = join(diagnosticsDir, readdirSync(diagnosticsDir)[0]);
  const output = logs.mock.calls.map((args) => args.join(' ')).join('\n');
  expect(readPtyPhaseRecords(output).filter((r) => r.producer === 'utility')).toEqual(utility);
  const emitted = output
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  expect(emitted).toContainEqual({
    event: 'pty-phase-summary',
    summary: JSON.parse(readFileSync(join(saved, 'phase-summary.json'), 'utf8')),
  });
});

const echoSessionId = 'echo-session';
const echoObserved =
  'PTY echo marker observed: OK_PTY_SMOKE; timings={}; endings=null; notices=null\n';
const retainedUtility = [
  ['utility-entry', 'point'],
  ['module-entry', 'point'],
  ['logger-import', 'begin'],
  ['logger-import', 'end'],
  ['native-import', 'begin'],
  ['native-import', 'end'],
  ['listener-ready', 'point'],
  ['message-received', 'point', echoSessionId],
  ['shell-resolution', 'begin', echoSessionId],
  ['shell-resolution', 'end', echoSessionId],
  ['pty-spawn', 'begin', echoSessionId],
  ['pty-spawn', 'end', echoSessionId],
  ['pty-first-output', 'point', echoSessionId],
  ['pty-first-forward', 'point', echoSessionId],
].map(([phase, edge, ptyId], index) => ({
  event: 'pty-phase',
  producer: 'utility',
  pid: 42,
  sequence: index + 1,
  atMs: index,
  timeOriginMs: 100,
  phase,
  edge,
  ...(ptyId ? { ptyId, currentSession: true } : {}),
}));

function pythonJsonLine(object) {
  const fields = Object.entries(object).map(
    ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{${fields.join(', ')}}`;
}

function collectedRendererTrace(records) {
  return `${JSON.stringify({
    event: 'pty-phase-trace',
    socketUrl: 'ws://127.0.0.1:9222/devtools/page/editor',
    records: records.map((record, index) => ({
      event: 'pty-phase',
      producer: 'renderer',
      sequence: index + 1,
      atMs: index,
      ...record,
    })),
  })}\n`;
}

function stageSuccessfulPackagedEcho({ stdout, stderr, utility = retainedUtility }) {
  const root = mkdtempSync(join(tmpdir(), 'ok-pty-evidence-renderer-trace-'));
  fixtures.push(root);
  const diagnosticsDir = join(root, 'evidence');
  const logDir = join(root, 'logs');
  mkdirSync(logDir);
  writeFileSync(join(root, 'OpenKnowledge.exe'), 'fixture');
  child.spawn.mockImplementation((_file, args, options) => {
    const profile = args
      .find((arg) => arg.startsWith('--user-data-dir='))
      .slice('--user-data-dir='.length);
    const paths = {
      event: 'pty-phase',
      producer: 'main',
      pid: 12345,
      sequence: 1,
      atMs: 0,
      wallTimeMs: Date.now(),
      phase: 'paths',
      edge: 'point',
      userDataDir: profile,
      logDir,
    };
    writeFileSync(join(logDir, 'desktop.log'), `${JSON.stringify(paths)}\n`);
    writeSync(options.stdio[1], [paths, ...utility].map((r) => JSON.stringify(r)).join('\n'));
    return { pid: 12345 };
  });
  child.spawnSync.mockImplementation((file) =>
    file === 'taskkill'
      ? { status: 0, signal: null, stdout: '', stderr: '' }
      : { status: 0, signal: null, stdout, stderr },
  );
  const emitted = [];
  for (const method of ['log', 'info', 'warn', 'error']) {
    vi.spyOn(console, method).mockImplementation((...args) => {
      emitted.push(args.map(String).join(' '));
    });
  }
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation((chunk) => {
      emitted.push(String(chunk));
      return true;
    });
  }
  const run = () =>
    runWindowsPackageTerminalSmoke({
      packageDir: root,
      diagnosticsDir,
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });
  const manifest = () =>
    JSON.parse(
      readFileSync(join(diagnosticsDir, readdirSync(diagnosticsDir)[0], 'manifest.json'), 'utf8'),
    );
  return { run, emitted, manifest };
}

test.each([
  { errorType: 'TimeoutError', error: 'the original echo budget is exhausted' },
  { errorType: 'ReplyPhaseTimeoutError', error: 'no CDP reply for id=1 within 0.4s' },
])(
  'passes a successful packaged echo whose renderer trace read failed with $errorType and names why and what went unchecked',
  ({ errorType, error }) => {
    const stderr = `${pythonJsonLine({ event: 'pty-phase-trace-unavailable', errorType, error })}\n`;
    const { run, emitted, manifest } = stageSuccessfulPackagedEcho({
      stdout: echoObserved,
      stderr,
    });
    expect(run).not.toThrow();
    expect(manifest().rendererCollectionUnavailable).toBe(true);
    const diagnostics = emitted.filter(
      (chunk) => chunk !== stderr && chunk.includes(errorType) && chunk.includes(error),
    );
    expect(diagnostics).toEqual([
      `Packaged PTY renderer trace unavailable (${errorType}: ${error}), so the renderer session of this passing echo and that session's utility phases (message-received, shell-resolution, pty-spawn, pty-first-output, pty-first-forward), main phases (utility-data-received, main-data-relay) and renderer phases (renderer-data-received) were not checked`,
    ]);
    expect(emitted.join('\n')).not.toContain('missing the renderer session');
  },
);

test('passes a successful packaged echo with an unavailable renderer trace whose retained utility evidence has startup but no renderer session phases', () => {
  const { run, manifest } = stageSuccessfulPackagedEcho({
    stdout: echoObserved,
    stderr: `${pythonJsonLine({
      event: 'pty-phase-trace-unavailable',
      errorType: 'TimeoutError',
      error: 'the original echo budget is exhausted',
    })}\n`,
    utility: retainedUtility.filter((record) => record.ptyId === undefined),
  });
  expect(run).not.toThrow();
  expect(manifest().rendererCollectionUnavailable).toBe(true);
});

test.each([
  {
    retained: 'is empty',
    utility: [],
    rejection: /^Packaged PTY phase evidence is missing utility /,
  },
  {
    retained: 'lacks the utility listener-ready point',
    utility: retainedUtility.filter((record) => record.phase !== 'listener-ready'),
    rejection: 'Packaged PTY phase evidence is missing utility listener-ready/point',
  },
  {
    retained: 'lacks the utility diagnostic entry point',
    utility: retainedUtility.filter((record) => record.phase !== 'utility-entry'),
    rejection: 'Packaged PTY phase evidence is missing utility utility-entry/point',
  },
  {
    retained: 'splits the utility startup across two processes',
    utility: retainedUtility.map((record) =>
      record.phase === 'listener-ready' ? { ...record, pid: 43 } : record,
    ),
    rejection: /^Packaged PTY phase evidence is missing utility /,
  },
])(
  'rejects a successful packaged echo with an unavailable renderer trace whose retained utility evidence $retained',
  ({ utility, rejection }) => {
    const { run, manifest } = stageSuccessfulPackagedEcho({
      stdout: echoObserved,
      stderr: `${pythonJsonLine({
        event: 'pty-phase-trace-unavailable',
        errorType: 'TimeoutError',
        error: 'the original echo budget is exhausted',
      })}\n`,
      utility,
    });
    expect(run).toThrow(rejection);
    expect(manifest().rendererCollectionUnavailable).toBe(true);
  },
);

test.each([
  {
    collected: 'lacks the renderer session start',
    renderer: [
      { phase: 'evaluation', edge: 'begin' },
      { phase: 'create', edge: 'begin' },
      { phase: 'create', edge: 'end' },
    ],
    utility: retainedUtility,
    rejection: 'Packaged PTY phase evidence is missing the renderer session',
  },
  {
    collected: 'has a renderer session whose first output was never forwarded',
    renderer: [
      { phase: 'evaluation', edge: 'begin' },
      { phase: 'start', edge: 'begin', ptyId: echoSessionId },
    ],
    utility: retainedUtility.filter((record) => record.phase !== 'pty-first-forward'),
    rejection:
      'Packaged PTY phase evidence is missing utility pty-first-forward/point for the renderer session',
  },
])(
  'rejects a successful packaged echo whose collected renderer trace $collected',
  ({ renderer, utility, rejection }) => {
    const { run, manifest } = stageSuccessfulPackagedEcho({
      stdout: `${collectedRendererTrace(renderer)}${echoObserved}`,
      stderr: '',
      utility,
    });
    expect(run).toThrow(rejection);
    expect(manifest().rendererCollectionUnavailable).toBe(false);
  },
);
