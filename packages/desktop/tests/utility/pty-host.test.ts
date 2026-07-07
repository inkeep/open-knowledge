import { describe, expect, test } from 'bun:test';
import {
  buildShellArgs,
  buildShellEnv,
  type HostReapProcess,
  installHostReaping,
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

/**
 * Unit tests for the PTY host message-routing contract. node-pty is injected
 * as a controllable fake — the real-shell-I/O path runs under Node via
 * `pty-host.real-io-harness.ts` (node-pty's reads don't pump under Bun).
 */

interface FakePty extends PtyProcessLike {
  writes: string[];
  resizes: Array<[number, number]>;
  killCount: number;
  killThrows: boolean;
  pauseCount: number;
  resumeCount: number;
  emitData(data: string): void;
  emitExit(event: { exitCode: number; signal?: number }): void;
}

function makeFakePty(): FakePty {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: { exitCode: number; signal?: number }) => void) | null = null;
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
  spawnCalls: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
  handle: ReturnType<typeof setupPtyHost>;
}

function makeHarness(opts?: {
  pty?: FakePty;
  spawn?: SpawnPty;
  env?: Record<string, string | undefined>;
  logger?: { warn: (o: Record<string, unknown>) => void };
}): Harness {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const posted: PtyHostOutgoingMessage[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: PtySpawnOptions }> = [];
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
    env: opts?.env ?? { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    logger: opts?.logger,
  });
  return {
    fire: (message) => handler?.({ data: message }),
    fireRaw: (data) => handler?.({ data }),
    posted,
    spawnCalls,
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

  test('bakes a launch command into a non-history `-c` spawn with an interactive exec tail', () => {
    // "Open in <Agent>": the command rides on `-c` (never typed through the line
    // editor → never written to the user's shell history), and the `exec` tail
    // hands the tab back to a fresh interactive shell after the agent exits.
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
    // Positive identity the project skill keys off to pick `ok open` over a
    // preview URL. Set even when the parent tries to clear it.
    const h = makeHarness({ env: { SHELL: '/bin/zsh', OK_DESKTOP_TERMINAL: '' } });
    h.fire(CREATE());
    const env = h.spawnCalls[0]?.options.env ?? {};
    expect(env.OK_DESKTOP_TERMINAL).toBe('1');
  });

  test('prepends ~/.ok/bin to the child PATH so `ok` resolves regardless of rc consent', () => {
    // OK spawns this shell itself — injecting the OK-owned bin dir touches
    // no file OK doesn't own, so the built-in terminal works even when the
    // user declined the shell-PATH rc edit.
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
    // EPERM (not ESRCH) means the kill reaped nothing — the shell may be
    // orphaned, so the host emits a diagnostic instead of swallowing it.
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
    // node-pty's native binding can reject with a non-Error value. `(err as
    // Error).message` would then be `undefined`, which the main-side
    // `asHostMessage` requires to be a string and silently drops — stranding the
    // panel in 'starting' with no exit ever routed. Coerce so the message is
    // always a string the contract can carry.
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

    // ptyIds are minted fresh per create, so a duplicate id is a contract skew;
    // the stale shell under that id is reaped rather than orphaned.
    h.fire(CREATE({ ptyId: 'dup' }));
    expect(first.killCount).toBe(0);
    h.fire(CREATE({ ptyId: 'dup' }));
    expect(first.killCount).toBe(1);

    // The replacement is the live one under that id; the stale one's output dies.
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
    // Neither shell is reaped — the second create added rather than superseded.
    expect(a.killCount).toBe(0);
    expect(b.killCount).toBe(0);
    // The first session is still live: its output continues to flow.
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

    // 'a' is gone: its late bytes are suppressed; 'b' keeps streaming.
    const before = h.posted.length;
    a.emitData('straggler');
    expect(h.posted.length).toBe(before);
    b.emitData('still-alive');
    expect(h.posted).toContainEqual({ type: 'data', ptyId: 'b', data: 'still-alive' });

    // Input still routes to the surviving session.
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

    // Idempotent across repeated teardown.
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

  test('drops a create whose launchCommand is present but not a string', () => {
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
});

describe('buildShellArgs', () => {
  test('a plain tab is the bare login interactive shell', () => {
    expect(buildShellArgs('/bin/zsh')).toEqual(['-l', '-i']);
    expect(buildShellArgs('/bin/zsh', '')).toEqual(['-l', '-i']);
  });

  test('a launch bakes the command on `-c` and execs into a fresh interactive shell', () => {
    expect(buildShellArgs('/bin/zsh', "codex 'hi'")).toEqual([
      '-l',
      '-i',
      '-c',
      "codex 'hi'; exec '/bin/zsh' -l -i",
    ]);
  });

  test('single-quotes the shell path in the exec tail (space/quote-safe)', () => {
    expect(buildShellArgs("/odd path/o'sh", "claude 'x'")).toEqual([
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
      MAYBE: undefined,
    });
    // `~/.ok/bin` rides in front of the inherited PATH — OK's own spawned
    // shell resolves `ok` regardless of the rc-consent decision.
    expect(env).toEqual({
      PATH: '/Users/x/.ok/bin:/usr/bin',
      HOME: '/Users/x',
      OK_DESKTOP_TERMINAL: '1',
    });
  });
});

describe('resolveShell', () => {
  test('prefers an override, then $SHELL, then the darwin fallback', () => {
    expect(resolveShell({ SHELL: '/bin/bash' }, '/usr/bin/fish')).toBe('/usr/bin/fish');
    expect(resolveShell({ SHELL: '/bin/bash' })).toBe('/bin/bash');
    expect(resolveShell({})).toBe('/bin/zsh');
    expect(resolveShell({ SHELL: '' })).toBe('/bin/zsh');
  });
});

/**
 * The host's self-reaping wiring (the no-orphan mechanism). Real lifecycle
 * events are emitted through the public installer against a fake process+handle
 * — a behavioral pin via real input, no mocking inside the unit. The real
 * process proof that a SIGTERM'd host actually reaps a live shell runs under
 * Node in `pty-host.reap-harness.ts` (gated by `pty-host-reap.test.ts`).
 */
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
    // The 'exit' backstop must not call proc.exit (it IS the exit path).
    expect(proc.exitCodes).toEqual([]);
  });

  test('reaping is idempotent across multiple teardown events', () => {
    const { handle, killCount } = makeReapHandle();
    const proc = new FakeReapProcess();
    installHostReaping(handle, proc);
    proc.emit('SIGTERM');
    proc.emit('exit');
    proc.emit('SIGINT');
    // The shell is killed exactly once; a second signal still exits the host.
    expect(killCount()).toBe(1);
    expect(proc.exitCodes).toEqual([0, 0]);
  });
});
