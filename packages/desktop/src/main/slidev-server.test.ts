import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const slidevLog = vi.hoisted(() => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
});
vi.mock('./desktop-logger.ts', () => ({ getLogger: () => slidevLog }));

function slidevWarnRecords(): Record<string, unknown>[] {
  return slidevLog.warn.mock.calls.map(([attrs]) => attrs as Record<string, unknown>);
}

import {
  okChildEnvOptionsFromProcess,
  okChildPathEntries,
  okManagedBinDirs,
} from '../shared/ok-child-env.ts';
import { cliProbeArgs } from './claude-readiness.ts';
import { validateSpawnPath } from './path-containment.ts';
import {
  adaptSlidevChild,
  buildSlidevInvocation,
  composeSlidevSpawnEnv,
  findFreePort,
  probeSlidevReady,
  type ReadinessProbe,
  type SlidevProcess,
  type StartSlidevDeps,
  signalSlidevChild,
  slidevSpawnEnv,
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
    slidevLog.warn.mockClear();
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
    expect(slidevWarnRecords()).toHaveLength(1);
    expect(slidevWarnRecords()[0]).toMatchObject({ event: 'slides-spawn-error', code: 'EMFILE' });
  });

  it('reports spawn-error when a free port cannot be found, under its own event', async () => {
    slidevLog.warn.mockClear();
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
    expect(result).toEqual({ ok: false, reason: 'port-error' });
    expect(spawned).toBe(false);
    expect(slidevWarnRecords()).toHaveLength(1);
    expect(slidevWarnRecords()[0]).toMatchObject({ event: 'slides-port-error', code: null });
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
    const child = fakeChildProcess(4321);
    const process = adaptSlidevChild(child);
    const onExit = vi.fn();
    process.onExit(onExit);

    child.emit('error', new Error('late pipe error'));

    expect(process.isAlive()).toBe(true);
    expect(process.spawnError).toBeUndefined();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('reports an error before a pid is assigned as a spawn failure', () => {
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
      'darwin',
      [],
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
      'darwin',
      [],
    );
    expect(invocation).toEqual({
      mode: 'interactive-shell',
      file: '/bin/zsh',
      args: ['-l', '-i', '-c', "set +m; slidev '/decks/talk/slides.md' --port 5301"],
      family: 'posix',
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
      'darwin',
      [],
    );
    expect(invocation).toEqual({
      mode: 'interactive-shell',
      file: 'zsh',
      args: ['-l', '-i', '-c', "set +m; slidev '/decks/o'\\''brien; rm -rf ~/deck.md' --port 3000"],
      family: 'posix',
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
      [],
    );
    expect(inv.mode).toBe('direct');
    expect(inv.file).toBe('/proj/node_modules/.bin/slidev');
    expect(inv.args).toEqual([deck, '--port', '4300']);
  });

  it('Linux global runs the terminal interactive shell and reasserts managed bins afterward', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/bin/zsh' },
      4300,
      'linux',
      ["/home/o'brien/.ok/bin"],
    );
    expect(inv.mode).toBe('interactive-shell');
    expect(inv.file).toBe('/bin/zsh');
    expect(inv.args).toEqual([
      '-i',
      '-c',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in an expected command string, not a JS template placeholder
      "case \":$PATH:\" in *:'/home/o'\\''brien/.ok/bin':*) ;; *) PATH='/home/o'\\''brien/.ok/bin'\"${PATH:+:$PATH}\" ;; esac; export PATH; set +m; slidev '/proj/decks/talk.md' --port 4300",
    ]);
  });

  it('emits the fish job-control opt-out rather than the POSIX one, so a config.fish that set job control full cannot leak the deck out of the killable group', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/usr/bin/fish' },
      4300,
      'linux',
      ['/managed/bin'],
    );
    expect(inv.args.at(-1)).not.toContain('set +m');
    expect(
      inv.args,
      'without an exact pin, any drift in the fish reassert or opt-out that is not the literal addition of `set +m` lands green here, and the containment oracle that would catch it needs a fish binary on the host',
    ).toEqual([
      '-i',
      '-c',
      "if not contains '/managed/bin' $PATH; set -gx PATH '/managed/bin' $PATH; end; status job-control none; slidev '/proj/decks/talk.md' --port 4300",
    ]);
  });

  it('omits the POSIX job-control opt-out for an unrecognized family, which runs inside a non-interactive exec /bin/sh -c wrapper whenever a managed bin dir resolves', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/usr/bin/nu' },
      4300,
      'linux',
      ['/managed/bin'],
    );
    expect(inv.args.at(-1)).not.toContain('set +m');
    expect(inv.args.at(-1)).toContain('exec /bin/sh -c ');
  });

  it('emits no shell wrapper at all for an unrecognized family when no managed bin dir resolves, which is the boundary of the wrapper above', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/usr/bin/nu' },
      4300,
      'linux',
      [],
    );
    expect(inv.args.at(-1)).not.toContain('set +m');
    expect(inv.args.at(-1)).not.toContain('exec /bin/sh -c ');
  });

  it('emits the POSIX job-control opt-out so the deck stays in the killable process group', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/bin/bash' },
      4300,
      'linux',
      ['/managed/bin'],
    );
    expect(inv.args.at(-1)).toContain('; set +m; slidev ');
  });

  it.each([
    ['posix', '/bin/bash', 'set +m; '],
    ['fish', '/usr/bin/fish', 'status job-control none; '],
  ] as const)(
    'keeps the %s job-control opt-out when no managed bin dir resolves, because it is composed above the empty-dirs early return in commandWithManagedPath',
    (_family, shell, optOut) => {
      const inv = buildSlidevInvocation(
        { source: 'global', projectRoot: '/proj', docPath: deck, shell },
        4300,
        'linux',
        [],
      );
      expect(
        inv.args.at(-1),
        'hasNoResolvableOkHome is a state this build reaches, so folding the opt-out into the PATH reassert would drop it for exactly the users whose managed bin dir does not resolve, and every other opt-out assertion drives a non-empty dir list',
      ).toBe(`${optOut}slidev '/proj/decks/talk.md' --port 4300`);
    },
  );

  it('composes its launch argv from the same shell-mode source as the presence probe', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const inv = buildSlidevInvocation(
        { source: 'global', projectRoot: '/proj', docPath: deck, shell: '/bin/bash' },
        4300,
        platform,
        [],
      );
      expect(inv.args.slice(0, -2)).toEqual(cliProbeArgs('slidev', platform).slice(0, -2));
    }
  });

  it('Windows project-local targets the .cmd shim via cmd.exe', () => {
    const inv = buildSlidevInvocation(
      { source: 'project-local', projectRoot: 'C:\\proj', docPath: deck, shell: '' },
      4300,
      'win32',
      [],
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
      [],
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
        [],
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
      [],
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
    slidevLog.warn.mockClear();
    const { child, kill } = fakeChild();
    const killWindowsTree = vi.fn(() => Promise.reject(new Error('taskkill failed')));

    await signalSlidevChild(child, 'SIGKILL', { platform: 'win32', killWindowsTree });

    expect(slidevWarnRecords()).toHaveLength(1);
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(slidevWarnRecords()[0]).toMatchObject({
      event: 'slides-tree-kill-failed',
      pid: 4321,
      signal: 'SIGKILL',
      err: new Error('taskkill failed'),
    });
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
    slidevLog.warn.mockClear();
    try {
      const { child } = fakeChild();
      const signal = signalSlidevChild(child, 'SIGTERM', {
        platform: 'win32',
        killWindowsTree: () => new Promise<void>(() => {}),
        timeoutMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await signal;

      expect(slidevWarnRecords()[0]).toMatchObject({
        event: 'slides-tree-kill-failed',
        err: new Error('taskkill timed out'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('composeSlidevSpawnEnv', () => {
  const alwaysDir = () => true;

  it('strips the Electron and GDK markers the terminal strips, so the login shell child sees the same env', () => {
    const env = composeSlidevSpawnEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/alice',
        OK_ELECTRON_PROTOCOL_HOST: '1',
        OK_LOCK_KIND: 'interactive',
        ELECTRON_RUN_AS_NODE: '1',
        GDK_PIXBUF_MODULEDIR: '/app/lib/gdk-pixbuf',
        GDK_PIXBUF_MODULE_FILE: '/app/lib/loaders.cache',
        GDK_THEME: 'Adwaita',
      },
      { platform: 'linux', home: '/home/alice' },
      () => false,
    );
    expect(env.OK_ELECTRON_PROTOCOL_HOST).toBeUndefined();
    expect(env.OK_LOCK_KIND).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.GDK_PIXBUF_MODULEDIR).toBeUndefined();
    expect(env.GDK_PIXBUF_MODULE_FILE).toBeUndefined();
    expect(env.GDK_THEME).toBe('Adwaita');
  });

  it('does not mark the slidev child as the OK Desktop terminal', () => {
    const env = composeSlidevSpawnEnv(
      { PATH: '/usr/bin', HOME: '/home/alice' },
      { platform: 'linux', home: '/home/alice' },
      () => false,
    );
    expect(env.OK_DESKTOP_TERMINAL).toBeUndefined();
  });

  it('leads PATH with the OK-managed bin dir, ahead of the appended tool dirs', () => {
    const env = composeSlidevSpawnEnv(
      { PATH: '/usr/bin', HOME: '/Users/alice' },
      { platform: 'darwin', home: '/Users/alice' },
      alwaysDir,
    );
    const entries = (env.PATH ?? '').split(':');
    expect(entries[0]).toBe('/Users/alice/.ok/bin');
    expect(entries).toContain('/opt/homebrew/bin');
    expect(entries.indexOf('/usr/bin')).toBeLessThan(entries.indexOf('/opt/homebrew/bin'));
  });

  it('writes through the inherited PATH key casing on win32 rather than adding a second key', () => {
    const env = composeSlidevSpawnEnv(
      { Path: 'C:\\Windows\\System32', HOME: 'C:\\Users\\alice' },
      { platform: 'win32', home: 'C:\\Users\\alice', cliBinDir: 'C:\\ok\\resources\\cli\\bin' },
      alwaysDir,
    );
    expect(env.PATH).toBeUndefined();
    expect((env.Path ?? '').split(';')[0]).toBe('C:\\ok\\resources\\cli\\bin');
  });
});

describe('missing Slidev child home', () => {
  it.each([undefined, ''])('warns without probing root tool directories for home %s', (home) => {
    slidevLog.warn.mockClear();
    const isDir = vi.fn(() => true);
    const env = composeSlidevSpawnEnv({ PATH: '/usr/bin' }, { platform: 'linux', home }, isDir);
    expect(env.PATH).toBe('/usr/bin');
    expect(isDir).not.toHaveBeenCalled();
    expect(slidevLog.warn).toHaveBeenCalledWith(
      { event: 'slides-no-ok-managed-home', platform: 'linux' },
      expect.any(String),
    );
  });
});

describe('slidevSpawnEnv', () => {
  function withParentEnv(overrides: Record<string, string>, run: () => void): void {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      run();
    } finally {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('runs the launch through the shared composer, so the markers the terminal strips are stripped here too', () => {
    withParentEnv(
      {
        OK_LOCK_KIND: 'interactive',
        ELECTRON_RUN_AS_NODE: '1',
        OK_ELECTRON_PROTOCOL_HOST: '1',
        GDK_PIXBUF_MODULEDIR: '/app/lib/gdk-pixbuf',
      },
      () => {
        const env = slidevSpawnEnv();
        expect(env.OK_LOCK_KIND).toBeUndefined();
        expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(env.OK_ELECTRON_PROTOCOL_HOST).toBeUndefined();
        expect(env.GDK_PIXBUF_MODULEDIR).toBeUndefined();
      },
    );
  });

  it.skipIf(process.platform === 'win32')(
    'puts the OK-managed bin dir its own options resolve onto the launch PATH',
    () => {
      const options = okChildEnvOptionsFromProcess();
      const dirs = okManagedBinDirs(options);
      expect(dirs).toHaveLength(1);
      expect(okChildPathEntries(slidevSpawnEnv(), options)).toContain(dirs[0]);
    },
  );
});
