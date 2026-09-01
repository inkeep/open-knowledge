import { OK_DESKTOP_TERMINAL_ENV } from '@inkeep/open-knowledge-core';
import { TERMINAL_SHELL_NOTICE_REASONS } from '@inkeep/open-knowledge-core/desktop-bridge';
import { describe, expect, test } from 'vitest';
import { isTerminalPlatform } from '../../src/shared/terminal-platform.ts';
import {
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

interface FakePty extends PtyProcessLike {
  writes: string[];
  resizes: Array<[number, number]>;
  killCount: number;
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
    kill() {
      this.killCount += 1;
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
    const h = makeHarness({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } });
    h.fire(CREATE({ launchCommand: "claude 'do the thing'" }));
    expect(h.spawnCalls[0]?.file).toBe('/bin/zsh');
    expect(h.spawnCalls[0]?.args).toEqual([
      '-l',
      '-i',
      '-c',
      "claude 'do the thing'; exec '/bin/zsh' -l -i",
    ]);
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
        OK_ELECTRON_PROTOCOL_HOST: '1',
        OK_LOCK_KIND: 'interactive',
      },
    });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBeUndefined();
    expect(env.OK_LOCK_KIND).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
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

  test('leaves PATH untouched when HOME is absent (nothing to resolve against)', () => {
    const h = makeHarness({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.PATH).toBe('/usr/bin');
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
    expect(h.spawnCalls[0]?.args).toEqual(['-l', '-i', '-c', "x 'y'; exec '/bin/zsh' -l -i"]);
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

  test.each([
    ...TERMINAL_SHELL_NOTICE_REASONS,
  ])('accepts a create carrying the shared reason %s and relays it verbatim', (reason) => {
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
  });

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
    expect(buildShellArgs('darwin', '/bin/zsh')).toEqual(['-l', '-i']);
    expect(buildShellArgs('darwin', '/bin/zsh', '')).toEqual(['-l', '-i']);
    expect(buildShellArgs('linux', '/bin/bash')).toEqual(['-i']);
    expect(buildShellArgs('linux', '/bin/bash', '')).toEqual(['-i']);
  });

  test('a macOS launch keeps login flags in the launcher and exec tail', () => {
    expect(buildShellArgs('darwin', '/bin/zsh', "codex 'hi'")).toEqual([
      '-l',
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/zsh' -l -i",
    ]);
  });

  test('a Linux launch is interactive without forcing login semantics', () => {
    expect(buildShellArgs('linux', '/bin/bash', "codex 'hi'")).toEqual([
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/bash' -i",
    ]);
  });

  test('single-quotes the shell path in the exec tail (space/quote-safe)', () => {
    expect(buildShellArgs('linux', "/odd path/o'sh", "claude 'x'")).toEqual([
      '-i',
      '-c',
      "claude 'x'; exec '/odd path/o'\\''sh' -i",
    ]);
    expect(buildShellArgs('darwin', "/odd path/o'sh", "claude 'x'")).toEqual([
      '-l',
      '-i',
      '-c',
      "claude 'x'; exec '/odd path/o'\\''sh' -l -i",
    ]);
  });
});

describe('buildShellEnv', () => {
  test('strips markers, drops undefined, preserves the rest, marks the desktop terminal', () => {
    const env = buildShellEnv({
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
    const env = buildShellEnv(
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
  expect(buildShellArgs('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual([]);
  expect(buildShellArgs('win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual([]);
  expect(buildShellArgs('win32', 'C:\\Program Files\\Git\\bin\\bash.exe')).toEqual([]);
});

describe('buildShellArgs Windows launch composition', () => {
  test('PowerShell uses -NoExit + EncodedCommand and preserves structured JSON', () => {
    const args = buildShellArgs('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', {
      executable: 'native.exe',
      args: ['--settings', '{"nested":"a\'b"}'],
    });
    expect(Array.isArray(args)).toBe(true);
    if (!Array.isArray(args)) throw new Error('expected PowerShell argv');
    expect(args.slice(0, 2)).toEqual(['-NoExit', '-EncodedCommand']);
    expect(Buffer.from(args[2] ?? '', 'base64').toString('utf16le')).toBe(
      "& 'native.exe' '--settings' '{\"nested\":\"a''b\"}'",
    );
  });

  test('cmd uses node-pty string mode so CRT quote remarshal is bypassed', () => {
    expect(
      buildShellArgs('win32', 'C:\\Windows\\System32\\cmd.exe', {
        executable: 'claude',
        args: [],
      }),
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
    const args = buildShellArgs('win32', shell, {
      executable: launchTokens[0] ?? '',
      args: launchTokens.slice(1),
    });
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
        message: expect.stringMatching(/unsafe batch argument/),
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: 'pty-host-launch-compose-failed',
        platform: 'win32',
        rung: 'override',
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

    let handler: ((event: { data: unknown }) => void) | null = null;
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
