import { homedir } from 'node:os';

import {
  OK_DESKTOP_TERMINAL_ENV,
  OK_HOSTED_AGENT_ENV,
  posixOkManagedBinDir,
} from '@inkeep/open-knowledge-core';
import { TERMINAL_SHELL_NOTICE_REASONS } from '@inkeep/open-knowledge-core/desktop-bridge';
import { describe, expect, test, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

import { isTerminalPlatform } from '../../src/shared/terminal-platform.ts';
import {
  buildLaunchEnv,
  buildShellArgs,
  buildShellEnv,
  type HostReapProcess,
  installHostReaping,
  installPtyImportFailureReply,
  type PtyCreateMessage,
  type PtyHostHandle,
  type PtyHostIncomingMessage,
  type PtyHostOutgoingMessage,
  type PtyProcessLike,
  type PtySpawnOptions,
  resolveShell,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';
import {
  type ConptyCursorSyncHost,
  CURSOR_POSITION_QUERY,
  createConptyCursorSyncHost,
} from '../support/conpty-cursor-sync-host.test-helper.ts';

interface FakePty extends PtyProcessLike {
  writes: string[];
  resizes: Array<[number, number]>;
  killCount: number;
  killSignals: Array<string | undefined>;
  killThrows: boolean;
  pauseCount: number;
  resumeCount: number;
  emitData(data: string): void;
  emitExit(event: { exitCode: number | undefined; signal?: number }): void;
}

function makeFakePty(): FakePty {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number | undefined; signal?: number }) => void) | null = null;
  return {
    pid: 4242,
    writes: [],
    resizes: [],
    killCount: 0,
    killThrows: false,
    pauseCount: 0,
    resumeCount: 0,
    onData(listener) {
      onData = listener;
    },
    onExit(listener) {
      onExit = listener;
    },
    write(data) {
      this.writes.push(data);
    },
    resize(cols, rows) {
      this.resizes.push([cols, rows]);
    },
    killSignals: [] as Array<string | undefined>,
    kill(signal?: string) {
      this.killCount += 1;
      this.killSignals.push(signal);
      if (this.killThrows) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
    pause() {
      this.pauseCount += 1;
    },
    resume() {
      this.resumeCount += 1;
    },
    emitData(data) {
      onData?.(data);
    },
    emitExit(event) {
      onExit?.(event);
    },
  };
}

interface Harness {
  fire(message: PtyHostIncomingMessage): void;
  fireRaw(data: unknown): void;
  posted: PtyHostOutgoingMessage[];
  spawnCalls: Array<{ file: string; args: string[] | string; options: PtySpawnOptions }>;
  materializedSupportFiles: Array<{
    cwd: string;
    file: NonNullable<import('@inkeep/open-knowledge-core').TerminalLaunchCommand['supportFile']>;
  }>;
  handle: ReturnType<typeof setupPtyHost>;
}

function makeHarness(opts?: {
  pty?: FakePty;
  spawn?: SpawnPty;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  userInfoShell?: () => string | null;
  shellExists?: (path: string) => boolean;
  pathProbe?: (command: string, env: Record<string, string | undefined>) => string | null;
  listDirectory?: (path: string) => readonly string[];
  cliBinDir?: string;
  logger?: {
    warn: (o: Record<string, unknown>) => void;
    info?: (o: Record<string, unknown>) => void;
  };
  exitHost?: (code: number) => void;
  flushLogger?: () => void;
  shutdownMs?: number;
  materializeSupportFile?: (
    cwd: string,
    file: NonNullable<import('@inkeep/open-knowledge-core').TerminalLaunchCommand['supportFile']>,
  ) => void;
}): Harness {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const posted: PtyHostOutgoingMessage[] = [];
  const spawnCalls: Array<{ file: string; args: string[] | string; options: PtySpawnOptions }> = [];
  const materializedSupportFiles: Harness['materializedSupportFiles'] = [];
  const pty = opts?.pty ?? makeFakePty();
  const spawn: SpawnPty =
    opts?.spawn ??
    ((file, args, options) => {
      spawnCalls.push({ file, args, options });
      return pty;
    });
  const handle = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(value) {
        posted.push(value);
      },
    },
    spawn,
    exitHost: opts?.exitHost,
    flushLogger: opts?.flushLogger,
    shutdownMs: opts?.shutdownMs,
    env: opts?.env ?? { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    platform: opts?.platform ?? 'darwin',
    userInfoShell: opts?.userInfoShell,
    shellExists: opts?.shellExists,
    pathProbe: opts?.pathProbe,
    listDirectory: opts?.listDirectory,
    cliBinDir: opts?.cliBinDir,
    materializeSupportFile:
      opts?.materializeSupportFile ??
      ((cwd, file) => {
        materializedSupportFiles.push({ cwd, file });
      }),
    logger: opts?.logger,
  });
  return {
    fire: (message) => handler?.({ data: message }),
    fireRaw: (data) => handler?.({ data }),
    posted,
    spawnCalls,
    materializedSupportFiles,
    handle,
  };
}

const CREATE = (over?: Partial<PtyCreateMessage>): PtyCreateMessage => ({
  type: 'create',
  ptyId: 'p1',
  cwd: '/project/root',
  cols: 80,
  rows: 24,
  ...over,
});

describe('setupPtyHost — create', () => {
  test('spawns the login interactive shell at the project root', () => {
    const h = makeHarness({ env: { SHELL: '/bin/bash', PATH: '/usr/bin' } });
    h.fire(CREATE());
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.file).toBe('/bin/bash');
    expect(h.spawnCalls[0]?.args).toEqual(['-l', '-i']);
    expect(h.spawnCalls[0]?.options.cwd).toBe('/project/root');
    expect(h.spawnCalls[0]?.options.cols).toBe(80);
    expect(h.spawnCalls[0]?.options.rows).toBe(24);
  });

  test('Linux creates the PTY with interactive non-login argv', () => {
    const h = makeHarness({
      platform: 'linux',
      env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      shellExists: (path) => path === '/bin/bash',
    });
    h.fire(CREATE());

    expect(h.spawnCalls[0]?.file).toBe('/bin/bash');
    expect(h.spawnCalls[0]?.args).toEqual(['-i']);
    expect(h.spawnCalls[0]?.args).not.toContain('-l');
  });

  test('Windows prefers the bundled ConPTY dll on the first spawn', () => {
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: () => false,
      pathProbe: () => null,
    });
    h.fire(CREATE({ cwd: 'C:\\project' }));

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.options.useConptyDll).toBe(true);
  });

  test('Windows probes pwsh on PATH once per host instead of once per tab', () => {
    let probeCalls = 0;
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: (path) => path === 'C:\\tools\\pwsh.exe',
      pathProbe: () => {
        probeCalls += 1;
        return 'C:\\tools\\pwsh.exe';
      },
    });

    h.fire(CREATE({ ptyId: 'p1', cwd: 'C:\\project' }));
    h.fire(CREATE({ ptyId: 'p2', cwd: 'C:\\project' }));

    expect(probeCalls).toBe(1);
    expect(h.spawnCalls.map((call) => call.file)).toEqual([
      'C:\\tools\\pwsh.exe',
      'C:\\tools\\pwsh.exe',
    ]);
  });

  test('Windows retries a PATH probe that did not produce a verdict', () => {
    let probeCalls = 0;
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: () => false,
      pathProbe: () => {
        probeCalls += 1;
        return null;
      },
      listDirectory: () => [],
    });

    h.fire(CREATE({ ptyId: 'p1', cwd: 'C:\\project' }));
    h.fire(CREATE({ ptyId: 'p2', cwd: 'C:\\project' }));

    expect(probeCalls).toBe(2);
  });

  test('bakes a launch command into a non-history `-c` spawn with an interactive exec tail', () => {
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    const h = makeHarness({ env });
    h.fire(CREATE({ launchCommand: "claude 'do the thing'" }));
    const [managedBinDir] = buildShellEnv(env, { platform: 'darwin' }).managedBinDirs;
    expect(managedBinDir).toBeDefined();
    expect(h.spawnCalls[0]?.file).toBe('/bin/zsh');
    expect(h.spawnCalls[0]?.args).toEqual([
      '-l',
      '-i',
      '-c',
      `case ":$PATH:" in *:'${managedBinDir}':*) ;; *) PATH='${managedBinDir}'"\${PATH:+:$PATH}" ;; esac; export PATH; claude 'do the thing'; exec '/bin/zsh' -l -i`,
    ]);
  });

  test('handleCreate threads the logger, so a POSIX terminal with no home leaves a trace', () => {
    vi.mocked(homedir).mockReturnValueOnce('');
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({
      platform: 'linux',
      env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      shellExists: (path) => path === '/bin/bash',
      logger: { warn: (entry) => warnings.push(entry) },
    });
    h.fire(CREATE());
    expect(
      warnings,
      'buildShellEnv warns through an injected logger, so dropping `logger: deps.logger` at the handleCreate call site would silently lose the terminal-side missing-home diagnostic',
    ).toContainEqual({ event: 'pty-host-no-ok-managed-home', platform: 'linux' });
  });

  test('records the resolved shell command family on POSIX, the platform where the question has an answer', () => {
    const entries: Record<string, unknown>[] = [];
    const h = makeHarness({
      platform: 'linux',
      env: { SHELL: '/usr/bin/fish', PATH: '/usr/bin' },
      shellExists: (path) => path === '/usr/bin/fish',
      logger: { warn: () => {}, info: (entry) => entries.push(entry) },
    });

    h.fire(CREATE());

    expect(
      entries,
      'the win32 sibling of this assertion cannot see this field (it is undefined there by construction, and toContainEqual reads an undefined-valued key as absent), so without this test the non-win32 path the field exists for is unasserted from both directions',
    ).toContainEqual({
      event: 'pty-host-shell-resolved',
      platform: 'linux',
      rung: 'env-shell',
      shellCommandFamily: 'fish',
    });
  });

  test('falls back to /bin/zsh when SHELL is unset', () => {
    const h = makeHarness({ env: { PATH: '/usr/bin' } });
    h.fire(CREATE());
    expect(h.spawnCalls[0]?.file).toBe('/bin/zsh');
  });

  test('honors an explicit shell override', () => {
    const h = makeHarness({ env: { SHELL: '/bin/bash' } });
    h.fire(CREATE({ cwd: '/x', cols: 10, rows: 10, shell: '/usr/bin/fish' }));
    expect(h.spawnCalls[0]?.file).toBe('/usr/bin/fish');
  });

  test('strips desktop-only env markers from the child shell env', () => {
    const h = makeHarness({
      env: {
        SHELL: '/bin/zsh',
        PATH: '/usr/bin',
        HOME: '/Users/alice',
        OK_ELECTRON_PROTOCOL_HOST: '1',
        OK_LOCK_KIND: 'interactive',
        [OK_HOSTED_AGENT_ENV]: '1',
      },
    });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBeUndefined();
    expect(env.OK_LOCK_KIND).toBeUndefined();
    expect(env[OK_HOSTED_AGENT_ENV]).toBeUndefined();
    expect(env.PATH).toBe('/Users/alice/.ok/bin:/usr/bin');
  });

  test('marks the shell as the OK Desktop terminal (OK_DESKTOP_TERMINAL=1)', () => {
    const h = makeHarness({ env: { SHELL: '/bin/zsh', [OK_DESKTOP_TERMINAL_ENV]: '' } });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env[OK_DESKTOP_TERMINAL_ENV]).toBe('1');
  });

  test('prepends ~/.ok/bin to the child PATH so `ok` resolves regardless of rc consent', () => {
    const h = makeHarness({
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', HOME: '/Users/alice' },
    });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.PATH).toBe('/Users/alice/.ok/bin:/usr/bin:/bin');
  });

  test('does not duplicate ~/.ok/bin when the parent PATH already carries it', () => {
    const h = makeHarness({
      env: {
        SHELL: '/bin/zsh',
        PATH: '/opt/x:/Users/alice/.ok/bin:/usr/bin',
        HOME: '/Users/alice',
      },
    });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.PATH).toBe('/opt/x:/Users/alice/.ok/bin:/usr/bin');
  });

  test('falls back to the home the CLI installer used when the env carries no HOME', () => {
    const h = makeHarness({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(
      env.PATH,
      'index.ts installs the CLI under osHomedir(), not process.env.HOME, so a terminal that skipped the grant here would omit a directory that exists on disk, and would disagree with the probe children that do resolve it',
    ).toBe(`${posixOkManagedBinDir(homedir())}:/usr/bin`);
  });
});

describe('setupPtyHost — streaming', () => {
  test('forwards shell output as data messages tagged with the ptyId', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'abc' }));
    pty.emitData('hello ');
    pty.emitData('world');
    expect(h.posted).toEqual([
      { type: 'data', ptyId: 'abc', data: 'hello ' },
      { type: 'data', ptyId: 'abc', data: 'world' },
    ]);
  });

  test('writes renderer input to the pty', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'input', ptyId: 'p1', data: 'ls -la\r' });
    expect(pty.writes).toEqual(['ls -la\r']);
  });

  test('resizes the pty', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'resize', ptyId: 'p1', cols: 120, rows: 40 });
    expect(pty.resizes).toEqual([[120, 40]]);
  });

  test('kills the pty on a kill message', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'kill', ptyId: 'p1' });
    expect(pty.killCount).toBe(1);
  });

  test('escalates a hung kill to SIGKILL when onExit never fires', async () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'kill', ptyId: 'p1' });
    expect(pty.killCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pty.killCount).toBe(2);
    expect(pty.killSignals).toEqual([undefined, 'SIGKILL']);
  });

  test('cancels SIGKILL escalate after onExit', async () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'kill', ptyId: 'p1' });
    pty.emitExit({ exitCode: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pty.killCount).toBe(1);
  });

  test('does not escalate SIGKILL after killActiveSessions', async () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.handle.killActive();
    expect(pty.killCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pty.killCount).toBe(1);
  });

  test('logs a reap-failed warning when kill throws a non-ESRCH error', () => {
    const pty = makeFakePty();
    pty.kill = () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    };
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({ pty, logger: { warn: (o) => warnings.push(o) } });
    h.fire(CREATE());
    expect(() => h.fire({ type: 'kill', ptyId: 'p1' })).not.toThrow();
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: 'pty-host-reap-failed', code: 'EPERM' }),
    );
  });

  test('routes pause/resume backpressure to the active pty', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.fire({ type: 'pause', ptyId: 'p1' });
    h.fire({ type: 'resume', ptyId: 'p1' });
    expect(pty.pauseCount).toBe(1);
    expect(pty.resumeCount).toBe(1);
  });
});

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const FOCUS_OUT = '\u001b[O';
const FOCUS_IN = '\u001b[I';
const SHIFT_F3 = '\u001b[1;2R';
const RECORDED_CURSOR_REPORT = '\u001b[13;81R';
const SMOKE_SPAWN_SIZE = { cols: 222, rows: 13 };
const MOVED_SIZE = { cols: 101, rows: 52 };
const POST_MOVE_COMMAND = 'Write-Output "PROCESS_after-move=$PID"';

interface TerminalLink {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  received(): string;
}

interface XtermSide {
  readonly sent: readonly string[];
  type(text: string): void;
  report(sequence: string): void;
  resize(size: { cols: number; rows: number }): void;
  answerCursorQueries(): void;
}

function createXtermSide(link: TerminalLink): XtermSide {
  const sent: string[] = [];
  let answered = 0;
  const send = (data: string): void => {
    sent.push(data);
    link.send(data);
  };
  return {
    sent,
    type(text) {
      for (const key of text) send(key);
    },
    report: send,
    resize({ cols, rows }) {
      link.resize(cols, rows);
    },
    answerCursorQueries() {
      const asked = link.received().split(CURSOR_POSITION_QUERY).length - 1;
      for (; answered < asked; answered += 1) send(RECORDED_CURSOR_REPORT);
    },
  };
}

function rendererReceived(h: Harness, ptyId: string): string {
  return h.posted
    .flatMap((message) =>
      message.type === 'data' && message.ptyId === ptyId ? [message.data] : [],
    )
    .join('');
}

function ptyHostLink(h: Harness, ptyId: string): TerminalLink {
  return {
    send: (data) => h.fire({ type: 'input', ptyId, data }),
    resize: (cols, rows) => h.fire({ type: 'resize', ptyId, cols, rows }),
    received: () => rendererReceived(h, ptyId),
  };
}

function startBundledConptySession(host: ConptyCursorSyncHost): { h: Harness; xterm: XtermSide } {
  const h = makeHarness({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    shellExists: (path) => path === PWSH,
    pathProbe: () => PWSH,
    spawn: () => host,
  });
  h.fire(CREATE({ cwd: 'C:\\project', ...SMOKE_SPAWN_SIZE }));
  return { h, xterm: createXtermSide(ptyHostLink(h, 'p1')) };
}

interface RecordedRetriedQuery {
  attempt: string;
  command: string;
  typedBeforeFirstQuery: string;
  typedBetweenQueries: string;
  typedBeforeReplies: string;
  shellRan: string;
}

const RECORDED_RETRIED_QUERIES: readonly RecordedRetriedQuery[] = [
  {
    attempt: 'bundled #10 of run 36140409827',
    command: 'Write-Output "PROCESS_1e6a4905ac984ac483cff50173bdb9b9=$PID"',
    typedBeforeFirstQuery: 'W',
    typedBetweenQueries: '',
    typedBeforeReplies: '',
    shellRan: 'Wite-Output "PROCESS_1e6a4905ac984ac483cff50173bdb9b9=$PID"',
  },
  {
    attempt: 'bundled #32 of run 36140409827',
    command: 'Write-Output "PROCESS_4b7e8901d77d4c309c337676fe637047=$PID"',
    typedBeforeFirstQuery: 'W',
    typedBetweenQueries: '',
    typedBeforeReplies: 'r',
    shellRan: 'Wrte-Output "PROCESS_4b7e8901d77d4c309c337676fe637047=$PID"',
  },
  {
    attempt: 'bundled #16 of run 36138023695',
    command: 'Write-Output "PROCESS_a292934b75004134ab1f29723a1243cb=$PID"',
    typedBeforeFirstQuery: 'W',
    typedBetweenQueries: 'ri',
    typedBeforeReplies: '',
    shellRan: 'Wrie-Output "PROCESS_a292934b75004134ab1f29723a1243cb=$PID"',
  },
  {
    attempt: 'bundled #18 of run 36138023695',
    command: 'Write-Output "PROCESS_8446c9b807c94289a86014529d59b33e=$PID"',
    typedBeforeFirstQuery: 'Write-Output',
    typedBetweenQueries: '',
    typedBeforeReplies: '',
    shellRan: 'Write-Output"PROCESS_8446c9b807c94289a86014529d59b33e=$PID"',
  },
];

function replayRetriedQuery(
  xterm: XtermSide,
  host: ConptyCursorSyncHost,
  recorded: RecordedRetriedQuery,
): void {
  const typedBeforeReplies =
    recorded.typedBeforeFirstQuery + recorded.typedBetweenQueries + recorded.typedBeforeReplies;
  if (!recorded.command.startsWith(typedBeforeReplies)) {
    throw new Error(
      `${recorded.attempt}: the keys typed before the replies must begin its command`,
    );
  }
  xterm.report(FOCUS_OUT);
  xterm.resize(MOVED_SIZE);
  xterm.report(FOCUS_IN);
  xterm.type(recorded.typedBeforeFirstQuery);
  host.shellReadsScreenBufferInfo();
  xterm.type(recorded.typedBetweenQueries);
  host.cursorSyncWaitTimesOut();
  host.shellReadsScreenBufferInfo();
  xterm.type(recorded.typedBeforeReplies);
  xterm.answerCursorQueries();
  xterm.type(`${recorded.command.slice(typedBeforeReplies.length)}\r`);
}

describe('setupPtyHost — cursor-position queries from the console host', () => {
  test.each(RECORDED_RETRIED_QUERIES)(
    'a query the bundled ConPTY host re-issued after its wait expired does not cost the shell a typed key ($attempt)',
    (recorded) => {
      const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
      const { xterm } = startBundledConptySession(host);

      replayRetriedQuery(xterm, host, recorded);

      expect(host.cursorQueriesIssued).toBe(2);
      expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([recorded.command]);
      expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(
        `${recorded.command}\r`,
      );
    },
  );

  test('a second query raised by a later resize while the first is unanswered does not cost the shell a typed key, even from a host that stops re-asking after a timeout', () => {
    const host = createConptyCursorSyncHost({
      ...SMOKE_SPAWN_SIZE,
      afterTimedOutQuery: 'stops-asking',
    });
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    expect(host.cursorQueriesIssued).toBe(1);
    xterm.resize(SMOKE_SPAWN_SIZE);
    xterm.type('r');
    host.shellReadsScreenBufferInfo();
    expect(host.cursorQueriesIssued).toBe(2);
    xterm.answerCursorQueries();
    xterm.type(`${POST_MOVE_COMMAND.slice('Wr'.length)}\r`);

    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
    expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(`${POST_MOVE_COMMAND}\r`);
  });

  test('a re-issued query split across output chunks is still recognized, so its late reply does not cost the shell a typed key', () => {
    const recorded = RECORDED_RETRIED_QUERIES[1] as RecordedRetriedQuery;
    const host = createConptyCursorSyncHost({
      ...SMOKE_SPAWN_SIZE,
      queryOutput: (queryNumber) =>
        queryNumber === 1 ? ['\u001b[?25l\u001b[', '6n'] : ['\u001b', '[6n\u001b[?25h'],
    });
    const { xterm } = startBundledConptySession(host);

    replayRetriedQuery(xterm, host, recorded);

    expect(host.cursorQueriesIssued).toBe(2);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([recorded.command]);
    expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(`${recorded.command}\r`);
  });

  test('a query answered before the wait expires still reaches the host, which takes the cursor position from the reply', () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);
    host.shellReadsScreenBufferInfo();

    expect(host.cursorQueriesIssued).toBe(1);
    expect(host.inputReceived.join('')).toBe(xterm.sent.join(''));
    expect(host.linesAcceptedByShell).toEqual([POST_MOVE_COMMAND]);
  });

  test('a query split across output chunks still reaches the renderer intact, and its reply still reaches the host', () => {
    const host = createConptyCursorSyncHost({
      ...SMOKE_SPAWN_SIZE,
      queryOutput: () => ['\u001b[', '6n'],
    });
    const { h, xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);

    expect(rendererReceived(h, 'p1')).toBe(host.outputEmitted.join(''));
    expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    expect(host.inputReceived.join('')).toBe(xterm.sent.join(''));
    expect(host.linesAcceptedByShell).toEqual([POST_MOVE_COMMAND]);
  });

  test('a Shift+F3 the user types after the host query was answered still reaches the host unchanged', () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    xterm.type('rite-Output');
    xterm.report(SHIFT_F3);
    xterm.type('rX\r');

    expect(host.inputReceived.join('')).toBe(xterm.sent.join(''));
    expect(host.linesAcceptedByShell).toEqual(['WXrite-Output']);
  });

  test.each(['darwin', 'linux'] as const)(
    'on %s, a shell application that asks for the cursor position twice gets both replies',
    (platform) => {
      const pty = makeFakePty();
      const h = makeHarness({
        pty,
        platform,
        env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
        shellExists: (path) => path === '/bin/bash',
      });
      h.fire(CREATE());
      const xterm = createXtermSide(ptyHostLink(h, 'p1'));

      pty.emitData(CURSOR_POSITION_QUERY);
      pty.emitData(CURSOR_POSITION_QUERY);
      xterm.answerCursorQueries();

      expect(pty.writes.join('')).toBe(RECORDED_CURSOR_REPORT.repeat(2));
    },
  );
});

describe('ConPTY cursor-sync host model — conformance to the recorded attempts', () => {
  test.each(RECORDED_RETRIED_QUERIES)(
    'fed the recorded bytes with nothing in between, it runs the command the shell ran in $attempt',
    (recorded) => {
      const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
      const xterm = createXtermSide({
        send: (data) => host.write(data),
        resize: (cols, rows) => host.resize(cols, rows),
        received: () => host.outputEmitted.join(''),
      });

      replayRetriedQuery(xterm, host, recorded);

      expect(host.linesAcceptedByShell).toEqual([recorded.shellRan]);
    },
  );
});

const WINDOWS_PWSH_SESSION = {
  platform: 'win32',
  env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
  shellExists: (path: string) => path === PWSH,
  pathProbe: () => PWSH,
} as const;
const VIM_START_UP_PROBES = [
  { probe: '\u001b[2;1H\u25bd\u001b[6n', reply: '\u001b[2;2R' },
  { probe: '\u001b[3;1H\u001bPzz\u001b\\\u001b[0%m\u001b[6n', reply: '\u001b[3;1R' },
] as const;
const DECXCPR_REPLY = '\u001b[?13;81R';
const SPLIT_QUERY_OUTPUT = (queryNumber: number): readonly string[] =>
  queryNumber === 1 ? ['\u001b[?25l\u001b[', '6n'] : ['\u001b', '[6n\u001b[?25h'];
const CURSOR_REPORT_DROPPED = {
  level: 'warn',
  entry: { event: 'pty-host-cursor-report-dropped', ptyId: 'p1' },
} as const;

function openWindowsTerminal(h: Harness, ptyId = 'p1'): XtermSide {
  h.fire(CREATE({ ptyId, cwd: 'C:\\project', ...SMOKE_SPAWN_SIZE }));
  return createXtermSide(ptyHostLink(h, ptyId));
}

function spawnInTurn(...ptys: PtyProcessLike[]): SpawnPty {
  const unspawned = [...ptys];
  return () => {
    const next = unspawned.shift();
    if (next === undefined) throw new Error('the host spawned more ptys than the test prepared');
    return next;
  };
}

function rendererChunks(h: Harness, ptyId: string): string[] {
  return h.posted.flatMap((message) =>
    message.type === 'data' && message.ptyId === ptyId ? [message.data] : [],
  );
}

function answerVimStartUpProbes(pty: FakePty, xterm: XtermSide): void {
  for (const { probe } of VIM_START_UP_PROBES) pty.emitData(probe);
  for (const { reply } of VIM_START_UP_PROBES) xterm.report(reply);
}

function answerOnlyTheFirstRetriedQuery(host: ConptyCursorSyncHost, xterm: XtermSide): void {
  xterm.resize(MOVED_SIZE);
  host.shellReadsScreenBufferInfo();
  host.cursorSyncWaitTimesOut();
  host.shellReadsScreenBufferInfo();
  xterm.report(RECORDED_CURSOR_REPORT);
}

function typeWithShiftF3(xterm: XtermSide): void {
  xterm.type('Write-Output');
  xterm.report(SHIFT_F3);
  xterm.type('rX\r');
}

describe("setupPtyHost — cursor-position replies outside the console host's resize sync", () => {
  test('with no size change since the session started, a Windows application that asks for the cursor position twice gets both replies', () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

    pty.emitData(CURSOR_POSITION_QUERY);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.answerCursorQueries();

    expect(pty.writes).toEqual([RECORDED_CURSOR_REPORT, RECORDED_CURSOR_REPORT]);
  });

  test.each([
    {
      size: 'the size it was created at',
      settle: (_pty: FakePty, xterm: XtermSide) => xterm.resize(SMOKE_SPAWN_SIZE),
    },
    {
      size: 'the size a finished sync left',
      settle: (pty: FakePty, xterm: XtermSide) => {
        xterm.resize(MOVED_SIZE);
        pty.emitData(CURSOR_POSITION_QUERY);
        xterm.answerCursorQueries();
        xterm.resize(MOVED_SIZE);
      },
    },
  ])(
    "a resize to the size the session already has withholds neither reply to vim's two start-up probes ($size)",
    ({ settle }) => {
      const pty = makeFakePty();
      const h = makeHarness({ pty, ...WINDOWS_PWSH_SESSION });
      const xterm = openWindowsTerminal(h);

      settle(pty, xterm);
      answerVimStartUpProbes(pty, xterm);

      expect(rendererReceived(h, 'p1')).toContain(
        VIM_START_UP_PROBES.map(({ probe }) => probe).join(''),
      );
      expect(pty.writes).toEqual(xterm.sent);
    },
  );

  test("once the console host's post-resize query is answered, vim's two start-up probes get both replies", () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.answerCursorQueries();
    answerVimStartUpProbes(pty, xterm);

    expect(pty.writes).toEqual([
      RECORDED_CURSOR_REPORT,
      ...VIM_START_UP_PROBES.map(({ reply }) => reply),
    ]);
  });

  test.each([
    { lookalike: 'a DECXCPR request', output: '\u001b[?6n' },
    { lookalike: 'a status request with code 16', output: '\u001b[16n' },
    { lookalike: 'the query text without its escape', output: '[6n' },
  ])(
    'a lookalike of the cursor query in host output during the resize sync is not taken for one, so a Shift+F3 typed after the real query was answered still reaches the host ($lookalike)',
    ({ output }) => {
      const host = createConptyCursorSyncHost({
        ...SMOKE_SPAWN_SIZE,
        queryOutput: () => [output, CURSOR_POSITION_QUERY],
      });
      const { xterm } = startBundledConptySession(host);

      xterm.resize(MOVED_SIZE);
      xterm.type('W');
      host.shellReadsScreenBufferInfo();
      xterm.answerCursorQueries();
      xterm.type('rite-Output');
      xterm.report(SHIFT_F3);
      xterm.type('rX\r');

      expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
      expect(host.inputReceived).toEqual(xterm.sent);
      expect(host.linesAcceptedByShell).toEqual(['WXrite-Output']);
    },
  );

  test('a surplus reply outstanding in one Windows session does not withhold a Shift+F3 typed in another', () => {
    const asking = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const typing = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const h = makeHarness({ ...WINDOWS_PWSH_SESSION, spawn: spawnInTurn(asking, typing) });
    const askingXterm = openWindowsTerminal(h, 'asking');
    const typingXterm = openWindowsTerminal(h, 'typing');

    answerOnlyTheFirstRetriedQuery(asking, askingXterm);
    typeWithShiftF3(typingXterm);

    expect(asking.cursorQueriesIssued).toBe(2);
    expect(asking.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    expect(typing.inputReceived).toEqual(typingXterm.sent);
    expect(typing.linesAcceptedByShell).toEqual(['WXrite-Output']);
  });

  test('a create that replaces a live Windows session under the same id starts with no reply outstanding', () => {
    const replaced = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const replacement = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const h = makeHarness({ ...WINDOWS_PWSH_SESSION, spawn: spawnInTurn(replaced, replacement) });

    answerOnlyTheFirstRetriedQuery(replaced, openWindowsTerminal(h));
    const xterm = openWindowsTerminal(h);
    typeWithShiftF3(xterm);

    expect(replaced.cursorQueriesIssued).toBe(2);
    expect(replacement.inputReceived).toEqual(xterm.sent);
    expect(replacement.linesAcceptedByShell).toEqual(['WXrite-Output']);
  });
});

describe("setupPtyHost — an application's cursor-position queries inside the console host's resize sync", () => {
  test('after a size change, before the console host asks for the cursor position, an application that asks for it twice before either reply, as vim does at start-up, gets only its first reply: the second is withheld with one warn record, and input after that reaches the host', () => {
    const records: Array<{ level: 'warn' | 'info'; entry: Record<string, unknown> }> = [];
    const pty = makeFakePty();
    const h = makeHarness({
      pty,
      ...WINDOWS_PWSH_SESSION,
      logger: {
        warn: (entry) => records.push({ level: 'warn', entry }),
        info: (entry) => records.push({ level: 'info', entry }),
      },
    });
    const xterm = openWindowsTerminal(h);
    const recordsAtStart = records.length;
    const recordsSinceStart = () => records.slice(recordsAtStart);
    const [vimFirstProbe, vimSecondProbe] = VIM_START_UP_PROBES;

    xterm.resize(MOVED_SIZE);
    answerVimStartUpProbes(pty, xterm);

    expect(rendererReceived(h, 'p1'), 'the output the renderer received').toBe(
      vimFirstProbe.probe + vimSecondProbe.probe,
    );
    expect(xterm.sent, 'the replies the renderer sent').toEqual([
      vimFirstProbe.reply,
      vimSecondProbe.reply,
    ]);
    expect(pty.writes, 'the input written to the host').toEqual([vimFirstProbe.reply]);
    expect(recordsSinceStart(), 'the records after both replies').toEqual([CURSOR_REPORT_DROPPED]);

    xterm.report(SHIFT_F3);
    answerVimStartUpProbes(pty, xterm);

    expect(
      pty.writes,
      'the input written to the host after the Shift+F3 and the second vim start',
    ).toEqual([vimFirstProbe.reply, SHIFT_F3, vimFirstProbe.reply, vimSecondProbe.reply]);
    expect(recordsSinceStart(), 'the records after the Shift+F3 and the second vim start').toEqual([
      CURSOR_REPORT_DROPPED,
    ]);
  });
});

describe("setupPtyHost — the surplus reply to the console host's resize sync", () => {
  test('while the surplus reply is outstanding, a DECXCPR reply and input that carries a reply among other bytes reach the host unchanged, and the surplus reply is still withheld', () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));
    const notALoneReply = [
      DECXCPR_REPLY,
      `x${RECORDED_CURSOR_REPORT}`,
      `${RECORDED_CURSOR_REPORT}x`,
      `\u001b[200~${RECORDED_CURSOR_REPORT}\u001b[201~`,
    ];

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.report(RECORDED_CURSOR_REPORT);
    for (const input of notALoneReply) xterm.report(input);
    expect(pty.writes).toEqual([RECORDED_CURSOR_REPORT, ...notALoneReply]);

    xterm.report(RECORDED_CURSOR_REPORT);

    expect(pty.writes, 'the input written once the surplus reply arrived').toEqual([
      RECORDED_CURSOR_REPORT,
      ...notALoneReply,
    ]);
  });

  test('a session on the OS ConPTY, after the bundled dll failed to load, also keeps a re-issued query from costing the shell a typed key', () => {
    const recorded = RECORDED_RETRIED_QUERIES[0] as RecordedRetriedQuery;
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const spawnOptions: PtySpawnOptions[] = [];
    const xterm = openWindowsTerminal(
      makeHarness({
        ...WINDOWS_PWSH_SESSION,
        spawn: (_file, _args, options) => {
          spawnOptions.push(options);
          if (spawnOptions.length === 1) {
            throw new Error('Cannot find conpty.dll beside conpty.node');
          }
          return host;
        },
      }),
    );

    replayRetriedQuery(xterm, host, recorded);

    expect(spawnOptions.map((options) => options.useConptyDll)).toEqual([true, false]);
    expect(host.cursorQueriesIssued).toBe(2);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([recorded.command]);
    expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(`${recorded.command}\r`);
  });

  test('each console host resize sync that withholds replies leaves exactly one warn record, naming its session and with no reply bytes in it, however many replies it withholds, and a reply that reaches the host leaves none', () => {
    const records: Array<{ level: 'warn' | 'info'; entry: Record<string, unknown> }> = [];
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const xterm = openWindowsTerminal(
      makeHarness({
        ...WINDOWS_PWSH_SESSION,
        spawn: () => host,
        logger: {
          warn: (entry) => records.push({ level: 'warn', entry }),
          info: (entry) => records.push({ level: 'info', entry }),
        },
      }),
    );
    const recordsAtStart = records.length;
    const recordsSinceStart = () => records.slice(recordsAtStart);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    expect(host.cursorQueriesIssued).toBe(3);

    xterm.report(RECORDED_CURSOR_REPORT);
    expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    expect(recordsSinceStart(), 'after the reply the host consumed').toEqual([]);

    xterm.report(RECORDED_CURSOR_REPORT);
    expect(recordsSinceStart(), 'after the first surplus reply').toEqual([CURSOR_REPORT_DROPPED]);

    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);
    expect(
      recordsSinceStart(),
      'after the second surplus reply of the same sync and the typed command',
    ).toEqual([CURSOR_REPORT_DROPPED]);

    xterm.resize(SMOKE_SPAWN_SIZE);
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    expect(host.cursorQueriesIssued).toBe(5);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.report(RECORDED_CURSOR_REPORT);

    expect(host.cursorReportsConsumed, 'the replies the host consumed').toEqual([
      { row: 13, column: 81 },
      { row: 13, column: 81 },
    ]);
    expect(recordsSinceStart(), 'after the surplus reply of the next sync').toEqual([
      CURSOR_REPORT_DROPPED,
      CURSOR_REPORT_DROPPED,
    ]);
  });

  test('each warn record names the Windows session whose surplus reply it withheld, when two sessions in one window each withhold one', () => {
    const records: Array<{ level: 'warn' | 'info'; entry: Record<string, unknown> }> = [];
    const recorded = RECORDED_RETRIED_QUERIES[0] as RecordedRetriedQuery;
    const firstTab = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const secondTab = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const h = makeHarness({
      ...WINDOWS_PWSH_SESSION,
      spawn: spawnInTurn(firstTab, secondTab),
      logger: {
        warn: (entry) => records.push({ level: 'warn', entry }),
        info: (entry) => records.push({ level: 'info', entry }),
      },
    });
    const firstTabXterm = openWindowsTerminal(h, 'first-tab');
    const secondTabXterm = openWindowsTerminal(h, 'second-tab');
    const recordsAtStart = records.length;

    replayRetriedQuery(firstTabXterm, firstTab, recorded);
    replayRetriedQuery(secondTabXterm, secondTab, recorded);

    expect(records.slice(recordsAtStart)).toEqual([
      { level: 'warn', entry: { event: 'pty-host-cursor-report-dropped', ptyId: 'first-tab' } },
      { level: 'warn', entry: { event: 'pty-host-cursor-report-dropped', ptyId: 'second-tab' } },
    ]);
  });

  test.each([
    {
      shape: 'each query in its own chunk',
      recorded: RECORDED_RETRIED_QUERIES[2] as RecordedRetriedQuery,
      queryOutput: undefined,
    },
    {
      shape: 'each query split across chunks',
      recorded: RECORDED_RETRIED_QUERIES[1] as RecordedRetriedQuery,
      queryOutput: SPLIT_QUERY_OUTPUT,
    },
  ])(
    'in a retried-query replay, the renderer gets the host output chunk for chunk and the host gets every renderer message but the surplus reply ($shape)',
    ({ recorded, queryOutput }) => {
      const host = createConptyCursorSyncHost({ ...SMOKE_SPAWN_SIZE, queryOutput });
      const { h, xterm } = startBundledConptySession(host);

      replayRetriedQuery(xterm, host, recorded);

      expect(host.cursorQueriesIssued).toBe(2);
      expect(rendererChunks(h, 'p1'), 'the output the renderer received').toEqual(
        host.outputEmitted,
      );
      expect(xterm.sent.filter((message) => message === RECORDED_CURSOR_REPORT)).toHaveLength(2);
      const surplusReply = xterm.sent.lastIndexOf(RECORDED_CURSOR_REPORT);
      expect(host.inputReceived, 'the input the host received').toEqual(
        xterm.sent.filter((_message, index) => index !== surplusReply),
      );
    },
  );
});

const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe("setupPtyHost — the console host's cursor query in its output", () => {
  test('when the console host re-issued its query before the pty-host read the first, both queries arrive in one output chunk and only the first reply reaches the host', () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY + CURSOR_POSITION_QUERY);
    xterm.answerCursorQueries();

    expect(xterm.sent, 'the replies the renderer sent').toEqual([
      RECORDED_CURSOR_REPORT,
      RECORDED_CURSOR_REPORT,
    ]);
    expect(pty.writes, 'the input written to the host').toEqual([RECORDED_CURSOR_REPORT]);
  });

  test.each([
    { split: 'one byte per chunk', queryOutput: () => [...CURSOR_POSITION_QUERY] },
    { split: 'split before its last byte', queryOutput: () => ['\u001b[6', 'n'] },
  ])(
    'a re-issued query the console host writes across output chunks is still recognized, so its late reply does not cost the shell a typed key ($split)',
    ({ queryOutput }) => {
      const recorded = RECORDED_RETRIED_QUERIES[0] as RecordedRetriedQuery;
      const host = createConptyCursorSyncHost({ ...SMOKE_SPAWN_SIZE, queryOutput });
      const { h, xterm } = startBundledConptySession(host);

      replayRetriedQuery(xterm, host, recorded);

      expect(host.cursorQueriesIssued).toBe(2);
      expect(rendererChunks(h, 'p1'), 'the output the renderer received').toEqual(
        host.outputEmitted,
      );
      expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([recorded.command]);
      expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(
        `${recorded.command}\r`,
      );
    },
  );

  test('output that only begins a cursor query before the next chunk breaks it off is not completed by later output, so a Shift+F3 typed after the real query was answered still reaches the host', () => {
    const host = createConptyCursorSyncHost({
      ...SMOKE_SPAWN_SIZE,
      queryOutput: () => ['\u001b[', '?25h', '6n', CURSOR_POSITION_QUERY],
    });
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    xterm.type('rite-Output');
    xterm.report(SHIFT_F3);
    xterm.type('rX\r');

    expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    expect(host.inputReceived).toEqual(xterm.sent);
    expect(host.linesAcceptedByShell).toEqual(['WXrite-Output']);
  });
});

describe("setupPtyHost — the console host's resize sync after any size change, in any Windows session", () => {
  test.each([
    { dimension: 'width', size: { cols: MOVED_SIZE.cols, rows: SMOKE_SPAWN_SIZE.rows } },
    { dimension: 'height', size: { cols: SMOKE_SPAWN_SIZE.cols, rows: MOVED_SIZE.rows } },
  ])(
    "a resize that changes only the $dimension also keeps the console host's re-issued query from costing the shell a typed key",
    ({ size }) => {
      const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
      const { xterm } = startBundledConptySession(host);

      xterm.resize(size);
      xterm.type('W');
      host.shellReadsScreenBufferInfo();
      host.cursorSyncWaitTimesOut();
      host.shellReadsScreenBufferInfo();
      xterm.answerCursorQueries();
      xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);

      expect(host.cursorQueriesIssued).toBe(2);
      expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
      expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(
        `${POST_MOVE_COMMAND}\r`,
      );
    },
  );

  test("a second move, after the console host's first resize sync was answered, also keeps the host's re-issued query from costing the shell a typed key", () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    expect(host.cursorReportsConsumed).toEqual([{ row: 13, column: 81 }]);
    xterm.resize(SMOKE_SPAWN_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    xterm.answerCursorQueries();
    xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);

    expect(host.cursorQueriesIssued).toBe(3);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
    expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(`${POST_MOVE_COMMAND}\r`);
  });

  test.each([
    {
      session: 'a cmd.exe shell',
      shellExists: () => false,
      create: CREATE({ cwd: 'C:\\project', ...SMOKE_SPAWN_SIZE }),
      spawned: { file: CMD_EXE, args: [] },
    },
    {
      session: 'a Windows PowerShell shell',
      shellExists: (path: string) => path === WINDOWS_POWERSHELL,
      create: CREATE({ cwd: 'C:\\project', ...SMOKE_SPAWN_SIZE }),
      spawned: { file: WINDOWS_POWERSHELL, args: [] },
    },
    {
      session: 'an agent launched through cmd /K',
      shellExists: () => false,
      create: CREATE({
        cwd: 'C:\\project',
        ...SMOKE_SPAWN_SIZE,
        launchCommand: { executable: 'claude', args: [] },
      }),
      spawned: { file: CMD_EXE, args: '/K claude' },
    },
  ])(
    "in a Windows session with $session, only the first reply to the console host's retried query reaches the host",
    ({ shellExists, create, spawned }) => {
      const pty = makeFakePty();
      const h = makeHarness({
        pty,
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows', ComSpec: CMD_EXE },
        shellExists,
        pathProbe: () => null,
        listDirectory: () => [],
      });
      h.fire(create);
      const xterm = createXtermSide(ptyHostLink(h, 'p1'));

      xterm.resize(MOVED_SIZE);
      pty.emitData(CURSOR_POSITION_QUERY);
      pty.emitData(CURSOR_POSITION_QUERY);
      xterm.answerCursorQueries();

      expect(h.spawnCalls.map(({ file, args }) => ({ file, args }))).toEqual([spawned]);
      expect(xterm.sent, 'the replies the renderer sent').toEqual([
        RECORDED_CURSOR_REPORT,
        RECORDED_CURSOR_REPORT,
      ]);
      expect(pty.writes, 'the input written to the host').toEqual([RECORDED_CURSOR_REPORT]);
    },
  );
});

describe("setupPtyHost — replies across the console host's resize syncs", () => {
  test("after both replies to the console host's retried query came back, a Shift+F3 the user types reaches the host", () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.answerCursorQueries();
    expect(xterm.sent, 'the replies the renderer sent').toEqual([
      RECORDED_CURSOR_REPORT,
      RECORDED_CURSOR_REPORT,
    ]);
    const writtenBeforeTheKey = pty.writes.length;

    xterm.report(SHIFT_F3);

    expect(pty.writes.slice(writtenBeforeTheKey), 'the input written for the key').toEqual([
      SHIFT_F3,
    ]);
  });

  test.each([
    {
      unmatched: 'a late reply from an application',
      aroundTheMove: (pty: FakePty, xterm: XtermSide) => {
        pty.emitData(CURSOR_POSITION_QUERY);
        xterm.resize(MOVED_SIZE);
        xterm.answerCursorQueries();
      },
      bytes: RECORDED_CURSOR_REPORT,
    },
    {
      unmatched: 'a Shift+F3 typed after the move',
      aroundTheMove: (_pty: FakePty, xterm: XtermSide) => {
        xterm.resize(MOVED_SIZE);
        xterm.report(SHIFT_F3);
      },
      bytes: SHIFT_F3,
    },
  ])(
    "a lone reply that no console host query is waiting for ($unmatched) reaches the host, and the surplus reply to the host's retried query after the move is still withheld",
    ({ aroundTheMove, bytes }) => {
      const pty = makeFakePty();
      const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

      aroundTheMove(pty, xterm);
      pty.emitData(CURSOR_POSITION_QUERY);
      pty.emitData(CURSOR_POSITION_QUERY);
      xterm.answerCursorQueries();

      expect(xterm.sent, 'the input the renderer sent').toEqual([
        bytes,
        RECORDED_CURSOR_REPORT,
        RECORDED_CURSOR_REPORT,
      ]);
      expect(pty.writes, 'the input written to the host').toEqual([bytes, RECORDED_CURSOR_REPORT]);
    },
  );

  test("a size change while the console host's query is unanswered still lets the reply reach the host, which then asks no more", () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    xterm.resize(SMOKE_SPAWN_SIZE);
    xterm.answerCursorQueries();
    expect(host.cursorReportsConsumed, 'the replies the host consumed').toEqual([
      { row: 13, column: 81 },
    ]);
    xterm.type(`${POST_MOVE_COMMAND.slice('W'.length)}\r`);
    host.shellReadsScreenBufferInfo();

    expect(host.cursorQueriesIssued).toBe(1);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
  });

  test("after a retried sync whose second reply never came back, the console host's next post-resize query still gets its reply", () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    answerOnlyTheFirstRetriedQuery(host, xterm);
    xterm.resize(SMOKE_SPAWN_SIZE);
    host.shellReadsScreenBufferInfo();
    expect(host.cursorQueriesIssued).toBe(3);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.type(`${POST_MOVE_COMMAND}\r`);

    expect(host.cursorReportsConsumed, 'the replies the host consumed').toEqual([
      { row: 13, column: 81 },
      { row: 13, column: 81 },
    ]);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
  });

  test("a surplus reply that arrives only after the next move is withheld, and the console host's retried query after that move costs the shell no typed key either", () => {
    const host = createConptyCursorSyncHost(SMOKE_SPAWN_SIZE);
    const { xterm } = startBundledConptySession(host);

    xterm.resize(MOVED_SIZE);
    xterm.type('W');
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.resize(SMOKE_SPAWN_SIZE);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.type('r');
    host.shellReadsScreenBufferInfo();
    host.cursorSyncWaitTimesOut();
    host.shellReadsScreenBufferInfo();
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.type(`${POST_MOVE_COMMAND.slice('Wr'.length)}\r`);

    expect(host.cursorQueriesIssued).toBe(4);
    expect(host.cursorReportsConsumed, 'the replies the host consumed').toEqual([
      { row: 13, column: 81 },
      { row: 13, column: 81 },
    ]);
    expect(host.linesAcceptedByShell, 'the command the shell ran').toEqual([POST_MOVE_COMMAND]);
    expect(host.keysReadByShell.join(''), 'the keys the shell read').toBe(`${POST_MOVE_COMMAND}\r`);
  });

  test("vim's probe, arriving between the first reply to the console host's retried query and the surplus one, still gets its reply while the surplus is withheld", () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));
    const [vimFirstProbe] = VIM_START_UP_PROBES;

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.report(RECORDED_CURSOR_REPORT);
    pty.emitData(vimFirstProbe.probe);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.report(vimFirstProbe.reply);

    expect(pty.writes, 'the input written to the host').toEqual([
      RECORDED_CURSOR_REPORT,
      vimFirstProbe.reply,
    ]);
  });
});

describe("setupPtyHost — bytes that only resemble the console host's resize sync", () => {
  test.each([
    { input: 'Ctrl+Up', bytes: '\u001b[1;5A' },
    { input: 'Shift+F1', bytes: '\u001b[1;2P' },
    { input: 'the reply text without its escape', bytes: '[13;81R' },
  ])(
    'a key or text that only resembles a reply ($input) reaches the host while the surplus reply is outstanding, and the surplus reply is still withheld',
    ({ bytes }) => {
      const pty = makeFakePty();
      const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

      xterm.resize(MOVED_SIZE);
      pty.emitData(CURSOR_POSITION_QUERY);
      pty.emitData(CURSOR_POSITION_QUERY);
      xterm.report(RECORDED_CURSOR_REPORT);
      xterm.report(bytes);
      expect(pty.writes, 'the input written before the surplus reply').toEqual([
        RECORDED_CURSOR_REPORT,
        bytes,
      ]);

      xterm.report(RECORDED_CURSOR_REPORT);

      expect(xterm.sent, 'the input the renderer sent').toEqual([
        RECORDED_CURSOR_REPORT,
        bytes,
        RECORDED_CURSOR_REPORT,
      ]);
      expect(pty.writes, 'the input written once the surplus reply arrived').toEqual([
        RECORDED_CURSOR_REPORT,
        bytes,
      ]);
    },
  );

  test("output with no cursor query in it, such as the echo of a key typed before the next move, does not let an earlier sync's surplus reply reach the host", () => {
    const pty = makeFakePty();
    const xterm = openWindowsTerminal(makeHarness({ pty, ...WINDOWS_PWSH_SESSION }));

    xterm.resize(MOVED_SIZE);
    pty.emitData(CURSOR_POSITION_QUERY);
    pty.emitData(CURSOR_POSITION_QUERY);
    xterm.report(RECORDED_CURSOR_REPORT);
    xterm.type('W');
    xterm.resize(SMOKE_SPAWN_SIZE);
    pty.emitData('W');
    xterm.report(RECORDED_CURSOR_REPORT);

    expect(xterm.sent, 'the input the renderer sent').toEqual([
      RECORDED_CURSOR_REPORT,
      'W',
      RECORDED_CURSOR_REPORT,
    ]);
    expect(pty.writes, 'the input written to the host').toEqual([RECORDED_CURSOR_REPORT, 'W']);
  });
});

describe('setupPtyHost — exit', () => {
  test('emits an exit message with exitCode and a null signal when none', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'e1' }));
    pty.emitExit({ exitCode: 0, signal: undefined });
    expect(h.posted.at(-1)).toEqual({ type: 'exit', ptyId: 'e1', exitCode: 0, signal: null });
  });

  test('passes the signal through on a signal-killed exit (crash)', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'e2' }));
    pty.emitExit({ exitCode: 0, signal: 9 });
    expect(h.posted.at(-1)).toEqual({ type: 'exit', ptyId: 'e2', exitCode: 0, signal: 9 });
  });

  test('forwards an undefined native exitCode for main-side normalization', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'race' }));
    pty.emitExit({ exitCode: undefined });

    expect(h.posted.at(-1)).toEqual({
      type: 'exit',
      ptyId: 'race',
      exitCode: undefined,
      signal: null,
    });
  });

  test('a dead pty does not forward late data (active-id guard)', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'g1' }));
    pty.emitExit({ exitCode: 0 });
    const before = h.posted.length;
    pty.emitData('straggler bytes');
    expect(h.posted.length).toBe(before);
  });
});

describe('setupPtyHost — Windows session that ends before its shell attached', () => {
  const WINDOWS_HOST = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    shellExists: () => false,
    pathProbe: () => null,
  } as const;
  const endings = (posted: PtyHostOutgoingMessage[]) =>
    posted.filter((message) => message.type === 'exit' || message.type === 'spawn-error');

  test('a pty that exits while still reporting pid 0 is reported as never started', () => {
    const pty = Object.assign(makeFakePty(), { pid: 0 });
    const h = makeHarness({ pty, ...WINDOWS_HOST });
    h.fire(CREATE({ ptyId: 'unattached', cwd: 'C:\\project' }));
    pty.emitExit({ exitCode: -1, signal: undefined });

    expect(endings(h.posted)).toEqual([
      { type: 'spawn-error', ptyId: 'unattached', shellNeverAttached: true, exitCode: -1 },
    ]);
  });

  test('a pty whose shell attached and then exited -1 without output is still a shell exit', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty, ...WINDOWS_HOST });
    h.fire(CREATE({ ptyId: 'attached', cwd: 'C:\\project' }));
    pty.emitExit({ exitCode: -1, signal: undefined });

    expect(endings(h.posted)).toEqual([
      { type: 'exit', ptyId: 'attached', exitCode: -1, signal: null },
    ]);
  });

  test('a never-attached pty that ends during shutdown still lets the host exit', () => {
    const pty = Object.assign(makeFakePty(), { pid: 0 });
    const exitHost = vi.fn();
    const h = makeHarness({ pty, exitHost, ...WINDOWS_HOST });
    h.fire(CREATE({ ptyId: 'unattached', cwd: 'C:\\project' }));
    h.fire({ type: 'shutdown' });
    expect(exitHost).not.toHaveBeenCalled();

    pty.emitExit({ exitCode: -1, signal: undefined });

    expect(exitHost).toHaveBeenCalledTimes(1);
    expect(exitHost).toHaveBeenCalledWith(0);
  });
});

describe('setupPtyHost — containment (AC5: host survives a PTY failure)', () => {
  test.each([
    'Cannot find conpty.dll beside conpty.node',
    'Failed to get conpty.node module handle: 126',
    'Failed to get conpty.node module file name: 126',
    'Failed to load conpty.dll: bad image',
  ])('retries deterministic loader failure %s once with the OS backend', (loaderError) => {
    const pty = makeFakePty();
    const calls: PtySpawnOptions[] = [];
    const warnings: Record<string, unknown>[] = [];
    const spawn: SpawnPty = (_file, _args, options) => {
      calls.push(options);
      if (calls.length === 1) throw new Error(loaderError);
      return pty;
    };
    const h = makeHarness({
      spawn,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: () => false,
      pathProbe: () => null,
      logger: { warn: (event) => warnings.push(event) },
    });
    h.fire(CREATE({ cwd: 'C:\\project' }));

    expect(calls.map((options) => options.useConptyDll)).toEqual([true, false]);
    expect(warnings).toContainEqual(
      expect.objectContaining({ event: 'pty-host-conpty-dll-fallback' }),
    );
    pty.emitData('fallback alive');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'p1', data: 'fallback alive' });
  });

  test('does not retry a non-loader Windows spawn failure', () => {
    const calls: PtySpawnOptions[] = [];
    const spawn: SpawnPty = (_file, _args, options) => {
      calls.push(options);
      throw new Error('EMFILE: too many open files');
    };
    const h = makeHarness({
      spawn,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: () => false,
      pathProbe: () => null,
    });
    h.fire(CREATE({ cwd: 'C:\\project' }));

    expect(calls).toHaveLength(1);
    expect(h.posted.at(-1)).toEqual({
      type: 'spawn-error',
      ptyId: 'p1',
      message: 'EMFILE: too many open files',
    });
  });

  test('contains a failed OS-backend retry as the existing spawn-error contract', () => {
    let calls = 0;
    const spawn: SpawnPty = () => {
      calls += 1;
      if (calls === 1) throw new Error('Cannot find conpty.dll beside conpty.node');
      throw new Error('CreatePseudoConsole failed');
    };
    const h = makeHarness({
      spawn,
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: () => false,
      pathProbe: () => null,
    });
    h.fire(CREATE({ cwd: 'C:\\project' }));

    expect(calls).toBe(2);
    expect(h.posted.at(-1)).toEqual({
      type: 'spawn-error',
      ptyId: 'p1',
      message: 'CreatePseudoConsole failed',
    });
  });

  test('a synchronous spawn throw surfaces as spawn-error, not a crash', () => {
    const spawn: SpawnPty = () => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    };
    const h = makeHarness({ spawn });
    expect(() => h.fire(CREATE())).not.toThrow();
    expect(h.posted).toEqual([
      { type: 'spawn-error', ptyId: 'p1', message: 'EMFILE: too many open files' },
    ]);
  });

  test('a non-Error spawn throw still surfaces a string spawn-error message', () => {
    const spawn: SpawnPty = () => {
      throw 'EMFILE: too many open files';
    };
    const h = makeHarness({ spawn });
    h.fire(CREATE());
    expect(h.posted).toEqual([
      { type: 'spawn-error', ptyId: 'p1', message: 'EMFILE: too many open files' },
    ]);
  });

  test('the host keeps routing after a spawn failure', () => {
    const goodPty = makeFakePty();
    let calls = 0;
    const spawn: SpawnPty = () => {
      calls += 1;
      if (calls === 1) throw new Error('spawn blew up');
      return goodPty;
    };
    const h = makeHarness({ spawn });
    h.fire(CREATE({ ptyId: 'bad' }));
    h.fire(CREATE({ ptyId: 'good' }));
    goodPty.emitData('alive');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'good', data: 'alive' });
  });

  test('swallows an ESRCH from killing an already-exited pty', () => {
    const pty = makeFakePty();
    pty.killThrows = true;
    const h = makeHarness({ pty });
    h.fire(CREATE());
    expect(() => h.fire({ type: 'kill', ptyId: 'p1' })).not.toThrow();
    expect(pty.killCount).toBe(1);
  });
});

describe('setupPtyHost — addressing', () => {
  test('ignores input/resize/kill/pause/resume for an unknown ptyId', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE({ ptyId: 'real' }));
    h.fire({ type: 'input', ptyId: 'ghost', data: 'x' });
    h.fire({ type: 'resize', ptyId: 'ghost', cols: 1, rows: 1 });
    h.fire({ type: 'kill', ptyId: 'ghost' });
    h.fire({ type: 'pause', ptyId: 'ghost' });
    h.fire({ type: 'resume', ptyId: 'ghost' });
    expect(pty.writes).toEqual([]);
    expect(pty.resizes).toEqual([]);
    expect(pty.killCount).toBe(0);
    expect(pty.pauseCount).toBe(0);
    expect(pty.resumeCount).toBe(0);
  });

  test('killActive reaps the live pty (window-close / quit)', () => {
    const pty = makeFakePty();
    const h = makeHarness({ pty });
    h.fire(CREATE());
    h.handle.killActive();
    expect(pty.killCount).toBe(1);
    h.handle.killActive();
    expect(pty.killCount).toBe(1);
  });

  test('a create reusing a live ptyId reaps the stale shell before replacing it (no orphan)', () => {
    const first = makeFakePty();
    const second = makeFakePty();
    const ptys = [first, second];
    let n = 0;
    const spawn: SpawnPty = () => ptys[n++] ?? makeFakePty();
    const h = makeHarness({ spawn });

    h.fire(CREATE({ ptyId: 'dup' }));
    expect(first.killCount).toBe(0);
    h.fire(CREATE({ ptyId: 'dup' }));
    expect(first.killCount).toBe(1);

    second.emitData('alive');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'dup', data: 'alive' });
    const before = h.posted.length;
    first.emitData('orphan');
    expect(h.posted.length).toBe(before);
  });
});

describe('setupPtyHost — concurrent sessions', () => {
  function makeMultiHarness(ptys: FakePty[]): Harness {
    let n = 0;
    const spawn: SpawnPty = () => ptys[n++] ?? makeFakePty();
    return makeHarness({ spawn });
  }

  test('a second create with a new id adds a session and leaves the first running', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const h = makeMultiHarness([a, b]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));
    expect(a.killCount).toBe(0);
    expect(b.killCount).toBe(0);
    a.emitData('a-still-here');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'a', data: 'a-still-here' });
  });

  test('both sessions stream concurrently, each tagged with its own ptyId', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const h = makeMultiHarness([a, b]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));
    a.emitData('from-a');
    b.emitData('from-b');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'a', data: 'from-a' });
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'b', data: 'from-b' });
  });

  test('input/resize/kill/pause/resume each act only on the addressed session', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const h = makeMultiHarness([a, b]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));

    h.fire({ type: 'input', ptyId: 'a', data: 'ls\r' });
    h.fire({ type: 'resize', ptyId: 'b', cols: 100, rows: 30 });
    h.fire({ type: 'pause', ptyId: 'a' });
    h.fire({ type: 'resume', ptyId: 'b' });
    h.fire({ type: 'kill', ptyId: 'a' });

    expect(a.writes).toEqual(['ls\r']);
    expect(b.writes).toEqual([]);
    expect(b.resizes).toEqual([[100, 30]]);
    expect(a.resizes).toEqual([]);
    expect(a.pauseCount).toBe(1);
    expect(b.pauseCount).toBe(0);
    expect(b.resumeCount).toBe(1);
    expect(a.resumeCount).toBe(0);
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(0);
  });

  test('one session exiting removes only its entry and leaves the other running', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const h = makeMultiHarness([a, b]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));

    a.emitExit({ exitCode: 0 });
    expect(h.posted).toContainEqual({ type: 'exit', ptyId: 'a', exitCode: 0, signal: null });

    const before = h.posted.length;
    a.emitData('straggler');
    expect(h.posted.length).toBe(before);
    b.emitData('still-alive');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'b', data: 'still-alive' });

    h.fire({ type: 'input', ptyId: 'b', data: 'x' });
    expect(b.writes).toEqual(['x']);
  });

  test('killActive reaps every session in the map (window/quit reap)', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const c = makeFakePty();
    const h = makeMultiHarness([a, b, c]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));
    h.fire(CREATE({ ptyId: 'c' }));

    h.handle.killActive();
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
    expect(c.killCount).toBe(1);

    h.handle.killActive();
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
    expect(c.killCount).toBe(1);
  });

  test('killActive keeps reaping after one session throws ESRCH (already exited)', () => {
    const a = makeFakePty();
    a.killThrows = true;
    const b = makeFakePty();
    const h = makeMultiHarness([a, b]);
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));
    expect(() => h.handle.killActive()).not.toThrow();
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
  });

  test('an internal shutdown message reaps every session and exits once', () => {
    const a = makeFakePty();
    const b = makeFakePty();
    const ptys = [a, b];
    const exitCodes: number[] = [];
    let flushCount = 0;
    let n = 0;
    const h = makeHarness({
      spawn: () => ptys[n++] ?? makeFakePty(),
      exitHost: (code) => exitCodes.push(code),
      flushLogger: () => {
        flushCount += 1;
      },
    });
    h.fire(CREATE({ ptyId: 'a' }));
    h.fire(CREATE({ ptyId: 'b' }));

    h.fireRaw({ type: 'shutdown' });
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
    expect(exitCodes).toEqual([]);

    a.emitExit({ exitCode: 0 });
    expect(exitCodes).toEqual([]);
    b.emitExit({ exitCode: 0 });
    expect(exitCodes).toEqual([0]);
    expect(flushCount).toBe(1);

    h.fireRaw({ type: 'shutdown' });
    expect(a.killCount).toBe(1);
    expect(b.killCount).toBe(1);
    expect(exitCodes).toEqual([0]);
    expect(flushCount).toBe(1);
  });

  test('shutdown exits on the host-local deadline when a deferred Windows kill never exits', async () => {
    const pty = makeFakePty();
    const exitCodes: number[] = [];
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({
      pty,
      shutdownMs: 1,
      exitHost: (code) => exitCodes.push(code),
      logger: { warn: (event) => warnings.push(event) },
    });
    h.fire(CREATE());

    h.fireRaw({ type: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pty.killCount).toBe(1);
    expect(exitCodes).toEqual([0]);
    expect(warnings).toContainEqual({ event: 'pty-host-shutdown-deadline', remaining: 1 });
  });
});

describe('setupPtyHost — incoming message validation (asIncomingMessage guard)', () => {
  function makeLogger() {
    const warnings: Array<Record<string, unknown>> = [];
    return { warn: (o: Record<string, unknown>) => warnings.push(o), warnings };
  }

  test('drops a message with a missing ptyId (no spawn, warns) so it cannot defeat the active-id guard', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({ type: 'create', cwd: '/x', cols: 80, rows: 24 });
    expect(h.spawnCalls).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test('drops a message with an empty-string ptyId', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({ type: 'input', ptyId: '', data: 'x' });
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test('a null or non-object message does not throw and is dropped', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    expect(() => h.fireRaw(null)).not.toThrow();
    expect(() => h.fireRaw('garbage')).not.toThrow();
    expect(h.spawnCalls).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test('accepts a create with a string launchCommand and bakes it', () => {
    const h = makeHarness();
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: "x 'y'",
    });
    expect(h.spawnCalls).toHaveLength(1);
    const [managedBinDir] = buildShellEnv({}, { platform: 'darwin' }).managedBinDirs;
    expect(managedBinDir).toBeDefined();
    expect(h.spawnCalls[0]?.args).toEqual([
      '-l',
      '-i',
      '-c',
      `case ":$PATH:" in *:'${managedBinDir}':*) ;; *) PATH='${managedBinDir}'"\${PATH:+:$PATH}" ;; esac; export PATH; x 'y'; exec '/bin/zsh' -l -i`,
    ]);
  });

  test('accepts a structured POSIX launch, quotes its argv and hands its env to the login alone', () => {
    const h = makeHarness();
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: '/rt/bin/npx',
        args: ['-y', '@augmentcode/auggie@1.2.3', '--acp', 'login'],
        env: { AUGGIE_LOGIN_FLOW: 'terminal' },
        pathPrepend: ['/rt/bin'],
      },
    });
    expect(h.spawnCalls).toHaveLength(1);
    const [managedBinDir] = buildShellEnv({}, { platform: 'darwin' }).managedBinDirs;
    expect(h.spawnCalls[0]?.args).toEqual([
      '-l',
      '-i',
      '-c',
      `case ":$PATH:" in *:'${managedBinDir}':*) ;; *) PATH='${managedBinDir}'"\${PATH:+:$PATH}" ;; esac; case ":$PATH:" in *:'/rt/bin':*) ;; *) PATH='/rt/bin'"\${PATH:+:$PATH}" ;; esac; export PATH; (export AUGGIE_LOGIN_FLOW="$OK_TERMINAL_LAUNCH_ENV_0"; exec '/rt/bin/npx' '-y' '@augmentcode/auggie@1.2.3' '--acp' 'login'); unset OK_TERMINAL_LAUNCH_ENV_0; exec '/bin/zsh' -l -i`,
    ]);
    expect(h.spawnCalls[0]?.options.env?.OK_TERMINAL_LAUNCH_ENV_0).toBe('terminal');
    expect(h.spawnCalls[0]?.options.env).not.toHaveProperty('AUGGIE_LOGIN_FLOW');
    expect(h.spawnCalls[0]?.args).not.toContain('terminal');
    expect(h.spawnCalls[0]?.options.env?.PATH).not.toContain('/rt/bin');
  });

  test('drops a structured launch whose env names, values or PATH dirs are malformed', () => {
    const h = makeHarness();
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: { executable: 'agent', args: ['login'], env: { A: 1 } },
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p3',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: { executable: 'agent', args: ['login'], env: { '--split-string': 'x' } },
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p5',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'agent',
        args: ['login'],
        env: { OK_TERMINAL_LAUNCH_ENV_0: 'the slot the launch itself uses' },
      },
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p4',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'agent',
        args: ['login'],
        env: { OK: `a${String.fromCharCode(0)}b` },
      },
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p2',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: { executable: 'agent', args: ['login'], pathPrepend: [''] },
    });
    expect(h.spawnCalls).toHaveLength(0);
  });

  test('accepts a structured Windows launch and composes it after shell resolution', () => {
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      shellExists: () => false,
      pathProbe: () => null,
      listDirectory: () => [],
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      launchCommand: { executable: 'claude', args: [] },
    });
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.args).toBe('/K claude');
  });

  test('materializes Claude settings beneath the cwd before composing a cmd-safe launch', () => {
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      shellExists: () => false,
      pathProbe: () => null,
      listDirectory: () => [],
    });
    const supportFile = {
      kind: 'claude-settings' as const,
      relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
      contents: '{"enabledMcpjsonServers":["open-knowledge"]}',
    };
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'claude',
        args: ['--settings', supportFile.relativePath],
        supportFile,
      },
    });

    expect(h.materializedSupportFiles).toEqual([{ cwd: 'C:\\project', file: supportFile }]);
    expect(h.spawnCalls[0]?.args).toBe(
      '/K claude --settings .ok/local/terminal/claude-settings-mcp-tools.json',
    );
  });

  test('opens a bare Claude launch when the settings support file cannot be written', () => {
    const logger = makeLogger();
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      shellExists: () => false,
      pathProbe: () => null,
      listDirectory: () => [],
      logger,
      materializeSupportFile: () => {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      },
    });
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: 'C:\\project',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'claude',
        args: ['--settings', '.ok/local/terminal/claude-settings-mcp-tools.json'],
        supportFile: {
          kind: 'claude-settings',
          relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
          contents: '{"enabledMcpjsonServers":["open-knowledge"]}',
        },
      },
    });

    expect(h.posted.filter((m) => m.type === 'spawn-error')).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.args).toBe('/K claude');
    expect(
      logger.warnings.some((w) => w.event === 'pty-host-support-file-materialize-failed'),
    ).toBe(true);
    expect(h.posted).toContainEqual({
      type: 'shell-notice',
      ptyId: 'p1',
      notice: 'support-file-degraded',
      reason: 'write-failed',
    });
  });

  test('rejects a support-file path outside the owned terminal settings directory', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: {
        executable: 'claude',
        args: ['--settings', '../../settings.json'],
        supportFile: {
          kind: 'claude-settings',
          relativePath: '../../settings.json',
          contents: '{}',
        },
      },
    });

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.materializedSupportFiles).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test('drops a create whose launchCommand has neither supported shape', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({ type: 'create', ptyId: 'p1', cwd: '/x', cols: 80, rows: 24, launchCommand: 123 });
    expect(h.spawnCalls).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test('an unknown message type lands in the default warn branch (forward-compat)', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({ type: 'bogus-future-type', ptyId: 'p1' });
    expect(h.spawnCalls).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });

  test.each([...TERMINAL_SHELL_NOTICE_REASONS])(
    'accepts a create carrying the shared reason %s and relays it verbatim',
    (reason) => {
      const h = makeHarness({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        shellExists: () => false,
        pathProbe: () => null,
        listDirectory: () => [],
      });

      h.fireRaw({
        type: 'create',
        ptyId: 'p1',
        cwd: 'C:\\project',
        cols: 80,
        rows: 24,
        shellInvalidReason: reason,
      });

      expect(h.spawnCalls).toHaveLength(1);
      expect(h.posted).toContainEqual({
        type: 'shell-notice',
        ptyId: 'p1',
        notice: 'invalid-shell-override',
        reason,
      });
    },
  );

  test('drops a create whose shellInvalidReason is outside the shared reason set', () => {
    const logger = makeLogger();
    const h = makeHarness({ logger });
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      shellInvalidReason: 'config-unreadable-ish',
    });
    expect(h.spawnCalls).toHaveLength(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});

describe('buildShellArgs', () => {
  test('a plain tab follows the platform interactive-shell convention', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', undefined, [])).toEqual(['-l', '-i']);
    expect(buildShellArgs('darwin', '/bin/zsh', '', [])).toEqual(['-l', '-i']);
    expect(buildShellArgs('linux', '/bin/bash', undefined, [])).toEqual(['-i']);
    expect(buildShellArgs('linux', '/bin/bash', '', [])).toEqual(['-i']);
  });

  test('a macOS launch keeps login flags in the launcher and exec tail', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', "codex 'hi'", [])).toEqual([
      '-l',
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/zsh' -l -i",
    ]);
  });

  test('a Linux launch is interactive without forcing login semantics', () => {
    expect(buildShellArgs('linux', '/bin/bash', "codex 'hi'", [])).toEqual([
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/bash' -i",
    ]);
  });

  test('reasserts the managed bin dir in the launched CLI command on macOS', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', "codex 'hi'", ['/managed/bin'])).toEqual([
      '-l',
      '-i',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an expected command string, not a JS template placeholder
      "case \":$PATH:\" in *:'/managed/bin':*) ;; *) PATH='/managed/bin'\"${PATH:+:$PATH}\" ;; esac; export PATH; codex 'hi'; exec '/bin/zsh' -l -i",
    ]);
  });

  test('reasserts the managed bin dir in the launched CLI command on Linux', () => {
    expect(buildShellArgs('linux', '/bin/bash', 'claude', ['/managed/bin'])).toEqual([
      '-i',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an expected command string, not a JS template placeholder
      "case \":$PATH:\" in *:'/managed/bin':*) ;; *) PATH='/managed/bin'\"${PATH:+:$PATH}\" ;; esac; export PATH; claude; exec '/bin/bash' -i",
    ]);
  });

  test('a structured POSIX launch reasserts its own dirs ahead of the managed ones', () => {
    expect(
      buildShellArgs(
        'linux',
        '/bin/bash',
        { executable: '/rt/bin/npx', args: ['-y', 'pkg@1', 'login'], pathPrepend: ['/rt/bin'] },
        ['/managed/bin'],
      ),
    ).toEqual([
      '-i',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an expected command string, not a JS template placeholder
      "case \":$PATH:\" in *:'/managed/bin':*) ;; *) PATH='/managed/bin'\"${PATH:+:$PATH}\" ;; esac; case \":$PATH:\" in *:'/rt/bin':*) ;; *) PATH='/rt/bin'\"${PATH:+:$PATH}\" ;; esac; export PATH; '/rt/bin/npx' '-y' 'pkg@1' 'login'; exec '/bin/bash' -i",
    ]);
  });

  test('several env values map each slot onto the same name in the script and in the spawn env', () => {
    const h = makeHarness();
    const env = { ZDOTDIR: '/agent/zdot', AUGGIE_HOME: '/agent/home' };
    h.fireRaw({
      type: 'create',
      ptyId: 'p1',
      cwd: '/x',
      cols: 80,
      rows: 24,
      launchCommand: { executable: 'agent', args: ['login'], env },
    });
    const call = h.spawnCalls[0];
    if (!call) throw new Error('no spawn');
    const script = call.args[3] ?? '';
    expect(script).toContain(
      `(export ZDOTDIR="$OK_TERMINAL_LAUNCH_ENV_0" AUGGIE_HOME="$OK_TERMINAL_LAUNCH_ENV_1"; exec 'agent' 'login'); unset OK_TERMINAL_LAUNCH_ENV_0 OK_TERMINAL_LAUNCH_ENV_1; exec`,
    );
    const pairs = [...script.matchAll(/(\w+)="\$(OK_TERMINAL_LAUNCH_ENV_\d+)"/g)].map((match) => [
      match[1] ?? '',
      match[2] ?? '',
    ]);
    expect(pairs).toEqual([
      ['ZDOTDIR', 'OK_TERMINAL_LAUNCH_ENV_0'],
      ['AUGGIE_HOME', 'OK_TERMINAL_LAUNCH_ENV_1'],
    ]);
    for (const [name, slot] of pairs) {
      expect(call.options.env?.[slot]).toBe(env[name as keyof typeof env]);
      expect(call.options.env).not.toHaveProperty(name);
    }
  });

  test('a structured launch under fish uses fish quoting for every token', () => {
    expect(
      buildShellArgs(
        'linux',
        '/usr/bin/fish',
        { executable: 'agent', args: ["it\\'s", 'trailing\\'], env: { A: "x'y" } },
        [],
      ),
    ).toEqual([
      '-i',
      '-c',
      `begin; set -lx A "$OK_TERMINAL_LAUNCH_ENV_0"; 'agent' 'it\\\\\\'s' 'trailing\\\\'; end; set -e OK_TERMINAL_LAUNCH_ENV_0; exec '/usr/bin/fish' -i`,
    ]);
  });

  test('uses fish list syntax for the reassert when the terminal shell is fish', () => {
    expect(buildShellArgs('linux', '/usr/bin/fish', 'claude', ['/managed/bin'])).toEqual([
      '-i',
      '-c',
      "if not contains '/managed/bin' $PATH; set -gx PATH '/managed/bin' $PATH; end; claude; exec '/usr/bin/fish' -i",
    ]);
  });

  test('a host with no grantable managed dir composes exactly the pre-reassert argv', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', "codex 'hi'", [])).toEqual([
      '-l',
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/zsh' -l -i",
    ]);
  });

  test('a plain interactive tab is never reasserted, so typed commands keep the user PATH order', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', undefined, ['/managed/bin'])).toEqual(['-l', '-i']);
    expect(buildShellArgs('linux', '/bin/bash', undefined, ['/managed/bin'])).toEqual(['-i']);
  });

  test('single-quotes the shell path in the exec tail (space/quote-safe)', () => {
    expect(buildShellArgs('linux', "/odd path/o'sh", "claude 'x'", [])).toEqual([
      '-i',
      '-c',
      "claude 'x'; exec '/odd path/o'\\''sh' -i",
    ]);
    expect(buildShellArgs('darwin', "/odd path/o'sh", "claude 'x'", [])).toEqual([
      '-l',
      '-i',
      '-c',
      "claude 'x'; exec '/odd path/o'\\''sh' -l -i",
    ]);
  });
});

describe('buildShellEnv', () => {
  test('strips markers, drops undefined, preserves the rest, marks the desktop terminal', () => {
    const { env } = buildShellEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      OK_ELECTRON_PROTOCOL_HOST: '1',
      OK_LOCK_KIND: 'interactive',
      ELECTRON_RUN_AS_NODE: '1',
      GDK_PIXBUF_MODULEDIR: '/app/lib/gdk-pixbuf',
      GDK_PIXBUF_MODULE_FILE: '/app/lib/loaders.cache',
      ELECTRON_TRASH: 'gio',
      GDK_THEME: 'Adwaita',
      MAYBE: undefined,
    });
    expect(env).toEqual({
      PATH: '/Users/x/.ok/bin:/usr/bin',
      HOME: '/Users/x',
      ELECTRON_TRASH: 'gio',
      GDK_THEME: 'Adwaita',
      [OK_DESKTOP_TERMINAL_ENV]: '1',
    });
  });

  test('win32 prepends the packaged CLI bin using the inherited PATH key casing', () => {
    const { env } = buildShellEnv(
      {
        Path: 'C:\\Windows\\System32;C:\\Tools',
        HOME: 'C:\\Users\\alice',
      },
      { platform: 'win32', cliBinDir: 'C:\\Program Files\\Open Knowledge\\resources\\cli\\bin' },
    );

    expect(env.Path).toBe(
      'C:\\Program Files\\Open Knowledge\\resources\\cli\\bin;C:\\Windows\\System32;C:\\Tools',
    );
    expect(env.PATH).toBeUndefined();
    expect(env.Path).not.toContain('.ok\\bin');
  });
});

describe('resolveShell', () => {
  const shellExists = (paths: string[]) => (path: string) => paths.includes(path);

  test('macOS preserves override, $SHELL, and zsh fallback behavior', () => {
    expect(
      resolveShell({ SHELL: '/bin/bash' }, { platform: 'darwin', override: '/usr/bin/fish' }),
    ).toBe('/usr/bin/fish');
    expect(resolveShell({ SHELL: '/bin/bash' }, { platform: 'darwin' })).toBe('/bin/bash');
    expect(resolveShell({}, { platform: 'darwin' })).toBe('/bin/zsh');
    expect(resolveShell({ SHELL: '' }, { platform: 'darwin' })).toBe('/bin/zsh');
  });

  test('Linux prefers $SHELL, then the passwd shell', () => {
    expect(
      resolveShell(
        { SHELL: '/usr/bin/fish' },
        {
          platform: 'linux',
          userInfoShell: () => '/bin/zsh',
          shellExists: shellExists(['/usr/bin/fish', '/bin/zsh']),
        },
      ),
    ).toBe('/usr/bin/fish');
    expect(
      resolveShell(
        { SHELL: '' },
        {
          platform: 'linux',
          userInfoShell: () => '/bin/zsh',
          shellExists: shellExists(['/bin/zsh']),
        },
      ),
    ).toBe('/bin/zsh');
  });

  test('Linux treats false-style and nonexistent configured shells as unset', () => {
    for (const configuredShell of [
      '/bin/false',
      '/usr/bin/false',
      '/usr/sbin/nologin',
      '/missing',
    ]) {
      expect(
        resolveShell(
          { SHELL: configuredShell },
          {
            platform: 'linux',
            userInfoShell: () => '/bin/fish',
            shellExists: shellExists(['/bin/fish']),
          },
        ),
      ).toBe('/bin/fish');
    }
  });

  test('Linux falls back through bash to sh when passwd lookup is absent', () => {
    expect(
      resolveShell(
        {},
        {
          platform: 'linux',
          userInfoShell: () => null,
          shellExists: shellExists(['/bin/bash', '/bin/sh']),
        },
      ),
    ).toBe('/bin/bash');
    expect(
      resolveShell(
        {},
        {
          platform: 'linux',
          userInfoShell: () => null,
          shellExists: shellExists(['/bin/sh']),
        },
      ),
    ).toBe('/bin/sh');
  });

  test('Linux logs and falls back when passwd lookup throws', () => {
    const warnings: Record<string, unknown>[] = [];

    expect(
      resolveShell(
        {},
        {
          platform: 'linux',
          userInfoShell: () => {
            throw Object.assign(new Error('no passwd entry'), { code: 'ENOENT' });
          },
          shellExists: shellExists(['/bin/bash', '/bin/sh']),
          logger: { warn: (data) => warnings.push(data) },
        },
      ),
    ).toBe('/bin/bash');
    expect(warnings).toContainEqual({
      event: 'pty-host-user-info-shell-failed',
      code: 'ENOENT',
    });
  });

  test('Linux ignores a false-style passwd shell before falling back', () => {
    expect(
      resolveShell(
        {},
        {
          platform: 'linux',
          userInfoShell: () => '/bin/false',
          shellExists: shellExists(['/bin/false', '/bin/bash', '/bin/sh']),
        },
      ),
    ).toBe('/bin/bash');
  });

  describe('win32 ladder', () => {
    const programFilesPwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const baseEnv = {
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      PATH: 'C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };

    test('honors an existing absolute override before probing PATH', () => {
      let probes = 0;
      expect(
        resolveShell(baseEnv, {
          platform: 'win32',
          override: 'D:\\Shells\\pwsh.exe',
          shellExists: shellExists(['D:\\Shells\\pwsh.exe']),
          pathProbe: () => {
            probes += 1;
            return 'C:\\PATH\\pwsh.exe';
          },
        }),
      ).toBe('D:\\Shells\\pwsh.exe');
      expect(probes).toBe(0);
    });

    test('uses the PATHEXT-aware PATH probe before known-install backstops', () => {
      expect(
        resolveShell(baseEnv, {
          platform: 'win32',
          pathProbe: (command, env) => {
            expect(command).toBe('pwsh');
            expect(env.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');
            return 'D:\\Portable\\pwsh.exe';
          },
          shellExists: shellExists(['D:\\Portable\\pwsh.exe', programFilesPwsh]),
        }),
      ).toBe('D:\\Portable\\pwsh.exe');
    });

    test('falls back to the Program Files PowerShell 7 install', () => {
      expect(
        resolveShell(baseEnv, {
          platform: 'win32',
          pathProbe: () => null,
          shellExists: shellExists([programFilesPwsh]),
        }),
      ).toBe(programFilesPwsh);
    });

    test('scans the WindowsApps PowerShell package aliases after Program Files', () => {
      const windowsApps = 'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps';
      const alias = `${windowsApps}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`;
      expect(
        resolveShell(baseEnv, {
          platform: 'win32',
          pathProbe: () => null,
          listDirectory: (path) =>
            path === windowsApps ? ['Other.App_123', 'Microsoft.PowerShell_8wekyb3d8bbwe'] : [],
          shellExists: shellExists([alias]),
        }),
      ).toBe(alias);
    });

    test('falls through to Windows PowerShell 5.1', () => {
      expect(
        resolveShell(baseEnv, {
          platform: 'win32',
          pathProbe: () => null,
          listDirectory: () => [],
          shellExists: shellExists([windowsPowerShell]),
        }),
      ).toBe(windowsPowerShell);
    });

    test('uses a case-insensitive ComSpec key before the cmd.exe floor', () => {
      expect(
        resolveShell(
          { ...baseEnv, ComSpec: undefined, cOmSpEc: 'D:\\Windows\\cmd.exe' },
          {
            platform: 'win32',
            pathProbe: () => null,
            listDirectory: () => [],
            shellExists: shellExists(['D:\\Windows\\cmd.exe']),
          },
        ),
      ).toBe('D:\\Windows\\cmd.exe');
    });

    test('uses the absolute cmd.exe floor and never consults SHELL', () => {
      expect(
        resolveShell(
          { ...baseEnv, SHELL: '/bin/zsh' },
          {
            platform: 'win32',
            pathProbe: () => null,
            listDirectory: () => [],
            shellExists: shellExists([]),
          },
        ),
      ).toBe(cmd);
    });

    test('empty and whitespace overrides are unset without an invalid-override notice', () => {
      for (const override of ['', '   ', '\t']) {
        const h = makeHarness({
          platform: 'win32',
          env: baseEnv,
          shellExists: shellExists([windowsPowerShell]),
          pathProbe: () => null,
          listDirectory: () => [],
        });
        h.fire(CREATE({ shell: override }));
        expect(h.spawnCalls[0]?.file).toBe(windowsPowerShell);
        expect(h.posted).not.toContainEqual(
          expect.objectContaining({
            type: 'shell-notice',
            ptyId: 'p1',
            notice: 'invalid-shell-override',
            reason: expect.any(String),
          }),
        );
      }
    });

    test('an invalid override logs, emits a notice, and continues down the ladder', () => {
      const warnings: Record<string, unknown>[] = [];
      const h = makeHarness({
        platform: 'win32',
        env: baseEnv,
        shellExists: shellExists([windowsPowerShell]),
        pathProbe: () => null,
        listDirectory: () => [],
        logger: { warn: (entry) => warnings.push(entry) },
      });

      h.fire(CREATE({ shell: 'C:\\Missing\\pwsh.exe' }));

      expect(h.spawnCalls[0]?.file).toBe(windowsPowerShell);
      expect(h.posted).toContainEqual({
        type: 'shell-notice',
        ptyId: 'p1',
        notice: 'invalid-shell-override',
        reason: 'not-found',
      });
      expect(warnings).toContainEqual(
        expect.objectContaining({
          event: 'pty-host-shell-override-invalid',
          platform: 'win32',
          reason: 'not-found',
        }),
      );
    });

    test('logs the selected bounded-cardinality ladder rung', () => {
      const entries: Record<string, unknown>[] = [];
      const h = makeHarness({
        platform: 'win32',
        env: baseEnv,
        shellExists: shellExists([programFilesPwsh]),
        pathProbe: () => null,
        logger: { warn: () => {}, info: (entry) => entries.push(entry) },
      });

      h.fire(CREATE());

      expect(entries).toContainEqual({
        event: 'pty-host-shell-resolved',
        platform: 'win32',
        rung: 'pwsh-known-install',
      });
    });
  });
});

test('buildShellArgs uses empty argv for every win32 shell rung', () => {
  expect(
    buildShellArgs('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', undefined, []),
  ).toEqual([]);
  expect(buildShellArgs('win32', 'C:\\Windows\\System32\\cmd.exe', undefined, [])).toEqual([]);
  expect(buildShellArgs('win32', 'C:\\Program Files\\Git\\bin\\bash.exe', undefined, [])).toEqual(
    [],
  );
});

describe('buildShellArgs Windows launch composition', () => {
  test('PowerShell uses -NoExit + EncodedCommand and preserves structured JSON', () => {
    const args = buildShellArgs(
      'win32',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      {
        executable: 'native.exe',
        args: ['--settings', '{"nested":"a\'b"}'],
      },
      [],
    );
    expect(Array.isArray(args)).toBe(true);
    if (!Array.isArray(args)) throw new Error('expected PowerShell argv');
    expect(args.slice(0, 2)).toEqual(['-NoExit', '-EncodedCommand']);
    expect(Buffer.from(args[2] ?? '', 'base64').toString('utf16le')).toBe(
      "& 'native.exe' '--settings' '{\"nested\":\"a''b\"}'",
    );
  });

  test('cmd uses node-pty string mode so CRT quote remarshal is bypassed', () => {
    expect(
      buildShellArgs(
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
        {
          executable: 'claude',
          args: [],
        },
        [],
      ),
    ).toBe('/K claude');
  });

  test('Git Bash preserves the structured launch through parser-inert base64 arguments', () => {
    const shell = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const launchTokens = [
      'codex',
      '-c',
      'mcp_servers.open-knowledge.default_tools_approval_mode=approve',
      "apostrophe'and space",
    ];
    const args = buildShellArgs(
      'win32',
      shell,
      {
        executable: launchTokens[0] ?? '',
        args: launchTokens.slice(1),
      },
      [],
    );
    expect(Array.isArray(args)).toBe(true);
    if (!Array.isArray(args)) throw new Error('expected Git Bash argv');

    expect(args.slice(0, 3)).toEqual(['--login', '-i', '-c']);
    expect(args[3]).toContain('base64 -d');
    expect(args[4]).toBe('bash');
    expect(
      Buffer.from(args[5] ?? '', 'base64')
        .toString('utf8')
        .split('\u0000'),
    ).toEqual([...launchTokens, '']);
  });

  test('the host reports the resolved Windows shell family before spawning', () => {
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      shellExists: (path) => path.endsWith('pwsh.exe'),
    });
    h.fire(CREATE());
    expect(h.posted).toContainEqual({
      type: 'shell-notice',
      ptyId: 'p1',
      notice: 'shell-resolved',
      shellFamily: 'powershell',
    });
  });

  test('an unsupported override degrades a structured launch to a plain interactive shell', () => {
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      shellExists: (path) => ['C:\\Tools\\fish.exe', 'C:\\Tools\\pwsh.exe'].includes(path),
      logger: { warn: (entry) => warnings.push(entry) },
    });

    h.fire(
      CREATE({
        shell: 'C:\\Tools\\fish.exe',
        launchCommand: {
          executable: 'claude',
          args: ['--settings', '.ok/local/terminal/claude-settings-mcp-tools.json'],
          supportFile: {
            kind: 'claude-settings',
            relativePath: '.ok/local/terminal/claude-settings-mcp-tools.json',
            contents: '{"enabledMcpjsonServers":["open-knowledge"]}',
          },
        },
      }),
    );

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.file).toBe('C:\\Tools\\fish.exe');
    expect(h.spawnCalls[0]?.args).toEqual([]);
    expect(h.materializedSupportFiles).toHaveLength(0);
    expect(h.posted).toContainEqual({
      type: 'shell-notice',
      ptyId: 'p1',
      notice: 'invalid-shell-override',
      reason: 'unsupported-family',
    });
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: 'spawn-error' }));
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-launch-degraded-unsupported-shell',
        platform: 'win32',
        rung: 'override',
      }),
    );

    h.fire(
      CREATE({
        ptyId: 'p2',
        shell: 'C:\\Tools\\pwsh.exe',
        launchCommand: { executable: 'claude', args: [] },
      }),
    );
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[1]?.file).toBe('C:\\Tools\\pwsh.exe');
    expect(h.spawnCalls[1]?.args).not.toEqual([]);
  });

  test('an unsupported override also degrades a managed command tab to a plain shell', () => {
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: (path) => ['C:\\Tools\\fish.exe', 'C:\\Tools\\pwsh.exe'].includes(path),
    });

    h.fire(
      CREATE({
        shell: 'C:\\Tools\\fish.exe',
        launchCommand: { executable: 'git', args: ['status'] },
      }),
    );

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]).toMatchObject({ file: 'C:\\Tools\\fish.exe', args: [] });
    expect(h.posted).toContainEqual({
      type: 'shell-notice',
      ptyId: 'p1',
      notice: 'invalid-shell-override',
      reason: 'unsupported-family',
    });
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: 'spawn-error' }));

    h.fire(
      CREATE({
        ptyId: 'p2',
        shell: 'C:\\Tools\\pwsh.exe',
        launchCommand: { executable: 'git', args: ['status'] },
      }),
    );
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.spawnCalls[1]?.file).toBe('C:\\Tools\\pwsh.exe');
    expect(h.spawnCalls[1]?.args).not.toEqual([]);
  });

  test('a structured launch composition failure aborts only that create request', () => {
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: (path) => path === 'C:\\Tools\\pwsh.exe',
      logger: { warn: (entry) => warnings.push(entry) },
    });

    h.fire(
      CREATE({
        shell: 'C:\\Tools\\pwsh.exe',
        launchCommand: { executable: 'agent.cmd', args: ['safe', '" & calc & "'] },
      }),
    );

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.posted).toContainEqual(
      expect.objectContaining({
        type: 'spawn-error',
        ptyId: 'p1',
        launchFailure: 'unsafe-argument',
      }),
    );
    expect(h.posted).not.toContainEqual(
      expect.objectContaining({ type: 'spawn-error', message: expect.any(String) }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-launch-compose-failed',
        platform: 'win32',
        rung: 'override',
        launchFailure: 'unsafe-argument',
      }),
    );

    h.fire(CREATE({ ptyId: 'p2', shell: 'C:\\Tools\\pwsh.exe' }));
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]?.file).toBe('C:\\Tools\\pwsh.exe');
  });

  test('an unsupported override keeps plain tabs usable with a capability notice', () => {
    const warnings: Record<string, unknown>[] = [];
    const h = makeHarness({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      shellExists: (path) => path === 'C:\\Tools\\fish.exe',
      logger: { warn: (entry) => warnings.push(entry) },
    });

    h.fire(CREATE({ shell: 'C:\\Tools\\fish.exe' }));

    expect(h.spawnCalls[0]?.file).toBe('C:\\Tools\\fish.exe');
    expect(h.posted).toContainEqual({
      type: 'shell-notice',
      ptyId: 'p1',
      notice: 'invalid-shell-override',
      reason: 'unsupported-family',
    });
    expect(h.posted).not.toContainEqual(
      expect.objectContaining({ type: 'shell-notice', notice: 'shell-resolved' }),
    );
    expect(warnings).toContainEqual({
      event: 'pty-host-shell-override-capability-limited',
      platform: 'win32',
      reason: 'unsupported-family',
    });
  });
});

describe('node-pty import failure', () => {
  test('a Linux-capable host replies to create with the existing spawn-error contract', () => {
    expect(isTerminalPlatform('linux')).toBe(true);

    let handler = null as ((event: { data: unknown }) => void) | null;
    const posted: PtyHostOutgoingMessage[] = [];
    const warnings: Array<{ data: Record<string, unknown>; message: string }> = [];
    installPtyImportFailureReply(
      {
        on(_event, nextHandler) {
          handler = nextHandler;
        },
        postMessage(message) {
          posted.push(message);
        },
      },
      new Error('node-pty Linux prebuild could not be loaded'),
      {
        warn(data, message) {
          warnings.push({ data, message });
        },
      },
    );

    handler?.({
      data: {
        type: 'create',
        ptyId: 'linux-pty',
        cwd: '/project',
        cols: 80,
        rows: 24,
      },
    });

    expect(posted).toEqual([
      {
        type: 'spawn-error',
        ptyId: 'linux-pty',
        message: 'node-pty Linux prebuild could not be loaded',
      },
    ]);
    expect(warnings).toEqual([
      {
        data: {
          event: 'pty-host-import-failed',
          error: 'node-pty Linux prebuild could not be loaded',
        },
        message: 'node-pty import failed',
      },
    ]);
  });
});

class FakeReapProcess implements HostReapProcess {
  exitCodes: number[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  on(event: 'exit' | NodeJS.Signals, listener: () => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  exit(code?: number): void {
    this.exitCodes.push(code ?? 0);
  }
  emit(event: 'exit' | NodeJS.Signals): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function makeReapHandle(): { handle: PtyHostHandle; killCount: () => number } {
  let count = 0;
  return {
    handle: {
      killActive() {
        count += 1;
      },
    },
    killCount: () => count,
  };
}

describe('installHostReaping', () => {
  test('SIGTERM reaps the active pty and exits the host', () => {
    const { handle, killCount } = makeReapHandle();
    const proc = new FakeReapProcess();
    installHostReaping(handle, proc);
    proc.emit('SIGTERM');
    expect(killCount()).toBe(1);
    expect(proc.exitCodes).toEqual([0]);
  });

  test('SIGINT and SIGHUP also reap + exit', () => {
    for (const signal of ['SIGINT', 'SIGHUP'] as const) {
      const { handle, killCount } = makeReapHandle();
      const proc = new FakeReapProcess();
      installHostReaping(handle, proc);
      proc.emit(signal);
      expect(killCount()).toBe(1);
      expect(proc.exitCodes).toEqual([0]);
    }
  });

  test('a plain exit reaps without re-triggering exit (sync backstop)', () => {
    const { handle, killCount } = makeReapHandle();
    const proc = new FakeReapProcess();
    installHostReaping(handle, proc);
    proc.emit('exit');
    expect(killCount()).toBe(1);
    expect(proc.exitCodes).toEqual([]);
  });

  test('reaping is idempotent across multiple teardown events', () => {
    const { handle, killCount } = makeReapHandle();
    const proc = new FakeReapProcess();
    installHostReaping(handle, proc);
    proc.emit('SIGTERM');
    proc.emit('exit');
    proc.emit('SIGINT');
    expect(killCount()).toBe(1);
    expect(proc.exitCodes).toEqual([0, 0]);
  });
});

describe('buildLaunchEnv', () => {
  test('a string launch keeps the shell env as is', () => {
    const env = { PATH: '/usr/bin', A: '1' };
    expect(buildLaunchEnv('darwin', env, "codex 'hi'")).toBe(env);
  });

  test('a structured launch parks its env in slot variables and leaves PATH to the command on POSIX', () => {
    expect(
      buildLaunchEnv(
        'darwin',
        { PATH: '/usr/bin', A: '1' },
        { executable: 'x', args: [], env: { B: '2' }, pathPrepend: ['/rt/bin'] },
      ),
    ).toEqual({ PATH: '/usr/bin', A: '1', OK_TERMINAL_LAUNCH_ENV_0: '2' });
  });

  test("a method env name never reaches the shell's startup environment", () => {
    const env = buildLaunchEnv(
      'darwin',
      { PATH: '/usr/bin', HOME: '/Users/me' },
      {
        executable: 'agent',
        args: ['login'],
        env: { ZDOTDIR: '/tmp/agent-owned', HOME: '/tmp/agent-owned', BASH_ENV: '/tmp/x.sh' },
      },
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      OK_TERMINAL_LAUNCH_ENV_0: '/tmp/agent-owned',
      OK_TERMINAL_LAUNCH_ENV_1: '/tmp/agent-owned',
      OK_TERMINAL_LAUNCH_ENV_2: '/tmp/x.sh',
    });
    expect(env).not.toHaveProperty('ZDOTDIR');
    expect(env).not.toHaveProperty('BASH_ENV');
  });

  test('a structured launch puts its PATH dirs first on Windows', () => {
    expect(
      buildLaunchEnv(
        'win32',
        { Path: 'C:\\Windows', A: '1' },
        { executable: 'x', args: [], pathPrepend: ['C:\\rt\\bin'] },
      ),
    ).toEqual({ Path: 'C:\\rt\\bin;C:\\Windows', A: '1' });
  });
});
