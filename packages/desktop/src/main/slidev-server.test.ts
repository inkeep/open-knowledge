import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSpawnPath } from './path-containment.ts';
import {
  adaptSlidevChild,
  buildSlidevInvocation,
  findFreePort,
  probeSlidevReady,
  type ReadinessProbe,
  type SlidevProcess,
  type StartSlidevDeps,
  signalSlidevChild,
  startSlidevServer,
} from './slidev-server.ts';

function fakeChildProcess(pid: number | undefined): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

function fakeProcess(opts: { exitImmediately?: boolean } = {}) {
  let exitCb: ((code: number | null) => void) | null = null;
  let alive = true;
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const proc: SlidevProcess = {
    onExit: (cb) => {
      exitCb = cb;
      if (opts.exitImmediately) {
        alive = false;
        cb(null);
      }
    },
    signal: (sig) => {
      signals.push(sig);
      return Promise.resolve();
    },
    isAlive: () => alive,
    pid: 4242,
  };
  return {
    proc,
    emitExit: (code: number | null = null) => {
      alive = false;
      exitCb?.(code);
    },
    signals: () => signals,
  };
}

function makeDeps(overrides: {
  probes: ReadinessProbe[];
  process?: ReturnType<typeof fakeProcess>;
  freePort?: number;
  spawn?: (port: number) => SlidevProcess;
  findFreePort?: () => Promise<number>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const proc = overrides.process ?? fakeProcess();
  const spawnCalls: number[] = [];
  let clock = 0;
  let probeIndex = 0;
  const probeQueries: number[] = [];
  const deps: StartSlidevDeps = {
    findFreePort: overrides.findFreePort ?? (() => Promise.resolve(overrides.freePort ?? 3030)),
    spawnSlidev:
      overrides.spawn ??
      ((port) => {
        spawnCalls.push(port);
        return proc.proc;
      }),
    probeReady: (port) => {
      probeQueries.push(port);
      const probe = overrides.probes[Math.min(probeIndex, overrides.probes.length - 1)];
      probeIndex += 1;
      return Promise.resolve(probe);
    },
    now: () => clock,
    delay: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    timeoutMs: overrides.timeoutMs ?? 1_000,
    pollIntervalMs: overrides.pollIntervalMs ?? 250,
  };
  return { deps, proc, spawnCalls, probeQueries };
}

describe('startSlidevServer', () => {
  it('reports success on the free port once the server serves a slidev deck', async () => {
    const { deps, proc, spawnCalls } = makeDeps({
      freePort: 5137,
      probes: [{ reachable: false }, { reachable: true, hasVersionMeta: true }],
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: true, port: 5137, process: proc.proc });
    expect(spawnCalls).toEqual([5137]);
    expect(proc.signals()).toEqual([]);
  });

  it('keeps polling while the server is not yet reachable', async () => {
    const { deps, probeQueries } = makeDeps({
      probes: [
        { reachable: false },
        { reachable: false },
        { reachable: true, hasVersionMeta: true },
      ],
    });
    const result = await startSlidevServer(deps);
    expect(result.ok).toBe(true);
    expect(probeQueries.length).toBe(3);
  });

  it('reports unsupported-server and reaps when a 200 lacks the version meta tag', async () => {
    const { deps, proc } = makeDeps({
      probes: [{ reachable: true, hasVersionMeta: false }],
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'unsupported-server' });
    expect(proc.signals()).toEqual(['SIGKILL']);
  });

  it('reports timeout and reaps when the server never becomes reachable', async () => {
    const { deps, proc } = makeDeps({
      probes: [{ reachable: false }],
      timeoutMs: 1_000,
      pollIntervalMs: 250,
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(proc.signals()).toEqual(['SIGKILL']);
  });

  it('reports exited-early when the process dies before it observes readiness', async () => {
    const proc = fakeProcess({ exitImmediately: true });
    const { deps, probeQueries } = makeDeps({
      process: proc,
      probes: [{ reachable: true, hasVersionMeta: true }],
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'exited-early' });
    expect(probeQueries.length).toBe(0);
    expect(proc.signals()).toEqual([]);
  });

  it('reports exited-early when the process dies during a poll', async () => {
    const proc = fakeProcess();
    let probed = false;
    const { deps } = makeDeps({
      process: proc,
      probes: [{ reachable: false }],
      spawn: () => proc.proc,
    });
    deps.probeReady = () => {
      if (!probed) {
        probed = true;
        proc.emitExit(1);
      }
      return Promise.resolve({ reachable: false });
    };
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'exited-early' });
  });

  it('reports spawn-error and logs the OS error code when the spawn throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emfile: NodeJS.ErrnoException = Object.assign(new Error('spawn EMFILE'), {
      code: 'EMFILE',
    });
    const { deps } = makeDeps({
      probes: [{ reachable: true, hasVersionMeta: true }],
      spawn: () => {
        throw emfile;
      },
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'spawn-error' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'slides-spawn-error',
      code: 'EMFILE',
    });
    warnSpy.mockRestore();
  });

  it('reports spawn-error when a free port cannot be found', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = fakeProcess();
    let spawned = false;
    const { deps } = makeDeps({
      process: proc,
      probes: [{ reachable: true, hasVersionMeta: true }],
      findFreePort: () => Promise.reject(new Error('bind failed')),
      spawn: () => {
        spawned = true;
        return proc.proc;
      },
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'spawn-error' });
    expect(spawned).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'slides-spawn-error',
      code: null,
    });
    warnSpy.mockRestore();
  });
});

describe('adaptSlidevChild', () => {
  it.each([0, null] as const)('marks the process dead and forwards exit code %s', (code) => {
    const child = fakeChildProcess(4321);
    const process = adaptSlidevChild(child);
    const onExit = vi.fn();
    process.onExit(onExit);

    child.emit('exit', code, code === null ? 'SIGTERM' : null);

    expect(process.isAlive()).toBe(false);
    expect(onExit).toHaveBeenCalledExactlyOnceWith(code);
  });

  it('keeps a spawned process alive and tracked after a child error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const child = fakeChildProcess(4321);
      const process = adaptSlidevChild(child);
      const onExit = vi.fn();
      process.onExit(onExit);

      child.emit('error', new Error('late pipe error'));

      expect(process.isAlive()).toBe(true);
      expect(process.spawnError).toBeUndefined();
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports an error before a pid is assigned as a spawn failure', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const child = fakeChildProcess(undefined);
      const process = adaptSlidevChild(child);
      const onExit = vi.fn();
      process.onExit(onExit);
      const error = Object.assign(new Error('not found'), { code: 'ENOENT' });

      child.emit('error', error);
      child.emit('exit', null, null);

      expect(process.isAlive()).toBe(false);
      expect(process.spawnError).toBe(error);
      expect(onExit).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildSlidevInvocation', () => {
  it('spawns a project-local install directly with the deck path and port', () => {
    const invocation = buildSlidevInvocation(
      {
        source: 'project-local',
        projectRoot: '/decks/talk',
        docPath: '/decks/talk/slides.md',
        shell: '/bin/zsh',
      },
      5301,
    );
    expect(invocation).toEqual({
      mode: 'direct',
      file: '/decks/talk/node_modules/.bin/slidev',
      args: ['/decks/talk/slides.md', '--port', '5301'],
    });
  });

  it('runs a global install through the login shell so PATH resolves slidev', () => {
    const invocation = buildSlidevInvocation(
      {
        source: 'global',
        projectRoot: '/decks/talk',
        docPath: '/decks/talk/slides.md',
        shell: '/bin/zsh',
      },
      5301,
    );
    expect(invocation).toEqual({
      mode: 'login-shell',
      file: '/bin/zsh',
      args: ['-l', '-i', '-c', "exec slidev '/decks/talk/slides.md' --port 5301"],
    });
  });

  it('single-quote-escapes a deck path so it cannot break out of the shell command', () => {
    const invocation = buildSlidevInvocation(
      {
        source: 'global',
        projectRoot: undefined,
        docPath: "/decks/o'brien; rm -rf ~/deck.md",
        shell: 'zsh',
      },
      3000,
    );
    expect(invocation).toEqual({
      mode: 'login-shell',
      file: 'zsh',
      args: ['-l', '-i', '-c', "exec slidev '/decks/o'\\''brien; rm -rf ~/deck.md' --port 3000"],
    });
  });
});

describe('findFreePort', () => {
  it('returns a port that is actually bindable', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(port, 'localhost', () => s.close(() => resolve()));
    });
  });
});

describe('probeSlidevReady', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  function serve(body: string, status = 200): Promise<number> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(body);
    });
    servers.push(server);
    return new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr !== null && typeof addr !== 'string' ? addr.port : 0);
      });
    });
  }

  it('reports reachable with the version meta present on a real slidev-shaped page', async () => {
    const port = await serve(
      '<html><head><meta property="slidev:version" content="52.18.1"></head><body></body></html>',
    );
    expect(await probeSlidevReady(port)).toEqual({ reachable: true, hasVersionMeta: true });
  });

  it('reports reachable without the version meta for a 200 that is not slidev', async () => {
    const port = await serve('<html><head><title>not slidev</title></head></html>');
    expect(await probeSlidevReady(port)).toEqual({ reachable: true, hasVersionMeta: false });
  });

  it('reports not-reachable for a non-200 response (still booting)', async () => {
    const port = await serve('<html>service unavailable</html>', 503);
    expect(await probeSlidevReady(port)).toEqual({ reachable: false });
  });

  it('reports not-reachable when nothing is listening on the port', async () => {
    const port = await findFreePort();
    expect(await probeSlidevReady(port)).toEqual({ reachable: false });
  });
});

describe('buildSlidevInvocation — platform matrix', () => {
  const deck = '/proj/decks/talk.md';

  it('POSIX project-local spawns the shim directly, no shell', () => {
    const inv = buildSlidevInvocation(
      { source: 'project-local', projectRoot: '/proj', docPath: deck, shell: '/bin/zsh' },
      4300,
      'linux',
    );
    expect(inv.mode).toBe('direct');
    expect(inv.file).toBe('/proj/node_modules/.bin/slidev');
    expect(inv.args).toEqual([deck, '--port', '4300']);
  });

  it('POSIX global routes through the login shell', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/bin/zsh' },
      4300,
      'linux',
    );
    expect(inv.mode).toBe('login-shell');
    expect(inv.file).toBe('/bin/zsh');
    expect(inv.args.slice(0, 3)).toEqual(['-l', '-i', '-c']);
  });

  it('Windows project-local targets the .cmd shim via cmd.exe', () => {
    const inv = buildSlidevInvocation(
      { source: 'project-local', projectRoot: 'C:\\proj', docPath: deck, shell: '' },
      4300,
      'win32',
    );
    expect(inv.mode).toBe('windows-shell');
    expect(inv.file).toBe('cmd.exe');
    const cmdline = inv.args[3] ?? '';
    expect(cmdline).toContain('slidev.cmd');
    expect(cmdline).toContain('node_modules');
    expect(cmdline).toContain(deck);
    expect(inv.verbatim).toBe(true);
  });

  it('Windows global lets cmd resolve slidev against PATHEXT', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: 'C:\\proj', docPath: deck, shell: '' },
      4300,
      'win32',
    );
    expect(inv.mode).toBe('windows-shell');
    expect(inv.file).toBe('cmd.exe');
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(inv.args[3]).toContain('"slidev"');
  });

  it('never emits POSIX login-shell flags on Windows', () => {
    for (const source of ['project-local', 'global'] as const) {
      const inv = buildSlidevInvocation(
        { source, projectRoot: 'C:\\proj', docPath: deck, shell: '' },
        4300,
        'win32',
      );
      expect(inv.args).not.toContain('-l');
      expect(inv.args).not.toContain('-i');
    }
  });
});

describe('buildSlidevInvocation — Windows command-line injection', () => {
  const evil = 'C:\\proj\\decks\\a&calc.exe&b.md';

  it('does not leave a live cmd.exe separator in the command line', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: 'C:\\proj', docPath: evil, shell: '' },
      4300,
      'win32',
    );
    expect(inv.args).not.toContain(evil);
    const cmdline = inv.args[3] ?? '';
    expect(cmdline.startsWith('"') && cmdline.endsWith('"')).toBe(true);
    const parsedByCmd = cmdline.slice(1, -1);
    const unquoted = parsedByCmd.replace(/"[^"]*"/g, '');
    expect(unquoted).not.toMatch(/[&|<>^]/);
    expect(parsedByCmd).toContain(`"${evil}"`);
  });

  it('refuses a deck path carrying characters cmd.exe quoting cannot neutralize', () => {
    expect(validateSpawnPath('C:\\proj\\%PATH%.md', 'win32')).toBe(false);
    expect(validateSpawnPath('C:\\proj\\a"b.md', 'win32')).toBe(false);
    expect(validateSpawnPath('C:\\proj\\Q1 & Q2.md', 'win32')).toBe(true);
  });
});

describe('signalSlidevChild', () => {
  function fakeChild() {
    const kill = vi.fn(() => true);
    return {
      child: { pid: 4321, kill } as unknown as ChildProcess,
      kill,
    };
  }

  it('terminates the complete cmd.exe process tree on Windows', async () => {
    const { child, kill } = fakeChild();
    const treeKills: number[] = [];

    await signalSlidevChild(child, 'SIGKILL', {
      platform: 'win32',
      killWindowsTree: async (pid) => {
        treeKills.push(pid);
      },
    });

    expect(treeKills).toEqual([4321]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('logs a failed Windows tree kill without retrying a bare PID', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { child, kill } = fakeChild();
    const killWindowsTree = vi.fn(() => Promise.reject(new Error('taskkill failed')));

    await signalSlidevChild(child, 'SIGKILL', { platform: 'win32', killWindowsTree });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'slides-tree-kill-failed',
      pid: 4321,
      signal: 'SIGKILL',
      message: 'taskkill failed',
    });
    warnSpy.mockRestore();
  });

  it('waits for the Windows tree kill to settle', async () => {
    const { child } = fakeChild();
    let release: (() => void) | undefined;
    const killWindowsTree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;

    const signal = signalSlidevChild(child, 'SIGTERM', {
      platform: 'win32',
      killWindowsTree,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await signal;
    expect(settled).toBe(true);
  });

  it('bounds a hanging Windows tree kill', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { child } = fakeChild();
      const signal = signalSlidevChild(child, 'SIGTERM', {
        platform: 'win32',
        killWindowsTree: () => new Promise<void>(() => {}),
        timeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await signal;

      expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
        event: 'slides-tree-kill-failed',
        message: 'taskkill timed out',
      });
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
