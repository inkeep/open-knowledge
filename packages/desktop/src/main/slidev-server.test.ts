/**
 * Tests for the Slidev start/readiness logic.
 *
 * `startSlidevServer` (the readiness state machine) is exercised with injected
 * spawn/port/probe/clock fakes — real-failure input at each injected boundary,
 * asserting the returned verdict and that no process is ever left running on a
 * failure. The real adapters that carry the I/O the state machine does not
 * (`findFreePort`, `probeSlidevReady`) are pinned against real ephemeral
 * sockets/servers; `buildSlidevInvocation`'s argv/quoting is pinned as a pure
 * function.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSpawnPath } from './path-containment.ts';
import {
  buildSlidevInvocation,
  findFreePort,
  probeSlidevReady,
  type ReadinessProbe,
  type SlidevProcess,
  type StartSlidevDeps,
  startSlidevServer,
} from './slidev-server.ts';

/** A fake spawned process: records the signals it was sent, lets a test drive
 *  the exit callback, and can model a launch that dies the instant it is
 *  observed. */
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

/** Assemble `StartSlidevDeps` from a scripted probe sequence + a virtual clock
 *  that `delay` advances, so timeouts are deterministic and instantaneous. */
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
      // Last scripted probe repeats, modelling a server that stays in that
      // state (e.g. never becomes reachable) until the deadline.
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
    // Spawned against exactly the port `findFreePort` handed back.
    expect(spawnCalls).toEqual([5137]);
    // A successful server is handed to the caller alive — not signalled here.
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
    // Did not give up on the first not-reachable probe.
    expect(probeQueries.length).toBe(3);
  });

  it('reports unsupported-server and reaps when a 200 lacks the version meta tag', async () => {
    const { deps, proc } = makeDeps({
      probes: [{ reachable: true, hasVersionMeta: false }],
    });
    const result = await startSlidevServer(deps);
    expect(result).toEqual({ ok: false, reason: 'unsupported-server' });
    // A foreign/too-old server is hard-reaped rather than opened onto — no orphan.
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
    // A hung start is hard-reaped so the deadline never leaks a process — no orphan.
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
    // Dead before the first probe — the poll short-circuits without probing.
    expect(probeQueries.length).toBe(0);
    // Already dead: nothing to signal.
    expect(proc.signals()).toEqual([]);
  });

  it('reports exited-early when the process dies during a poll', async () => {
    const proc = fakeProcess();
    // The first probe both reports not-reachable AND kills the server, so the
    // post-probe exit check catches the death.
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
    // The OS code is logged so EMFILE / ENOMEM / EACCES stay separable in
    // diagnostics rather than collapsing into an undiagnosable 'spawn-error'.
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
    // Never spawned when we could not even secure a port.
    expect(spawned).toBe(false);
    // A port-bind failure is logged too (code null — a plain Error carries none).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'slides-spawn-error',
      code: null,
    });
    warnSpy.mockRestore();
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
    // The embedded quote is escaped as '\'' and the whole path stays one token.
    expect(invocation).toEqual({
      mode: 'login-shell',
      file: 'zsh',
      args: ['-l', '-i', '-c', "exec slidev '/decks/o'\\''brien; rm -rf ~/deck.md' --port 3000"],
    });
  });

  // (The former `project-local` + absent-root fallback test is gone: the
  // discriminated `SlidevSpawnConfig` makes that state unrepresentable, so
  // `buildSlidevInvocation` no longer needs a runtime guard for it.)
});

describe('findFreePort', () => {
  it('returns a port that is actually bindable', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    // Prove it is free on the same host findFreePort binds (localhost) — the
    // family Slidev then binds too: bind and release it.
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

  /** Start an HTTP server returning `status`/`body` and resolve its port. */
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
    // A just-released port answers ECONNREFUSED — the not-yet-listening state.
    const port = await findFreePort();
    expect(await probeSlidevReady(port)).toEqual({ reachable: false });
  });
});

describe('buildSlidevInvocation — platform matrix', () => {
  // The decision is pure and takes `platform`, so every branch is verifiable
  // from any host. What this CANNOT prove is that the Windows spawn actually
  // succeeds — that needs a Windows runtime, and the port spec's Tier-B work.
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
    // `CreateProcess` cannot run the extension-less POSIX shim npm also writes,
    // and a `.cmd` needs a command processor.
    const inv = buildSlidevInvocation(
      { source: 'project-local', projectRoot: 'C:\\proj', docPath: deck, shell: '' },
      4300,
      'win32',
    );
    expect(inv.mode).toBe('windows-shell');
    expect(inv.file).toBe('cmd.exe');
    // Assert the DECISION (which shim name), not the separator: `node:path`'s
    // `join` follows the HOST, so a win32 path built on macOS uses `/`. In
    // production host and target are the same machine, so this is only a
    // cross-host testing artefact.
    //
    // The target and deck path live inside the single cmd-quoted command line
    // rather than in their own argv slots — that IS the fix for the cmd.exe
    // re-parse, so asserting the slot shape would pin the vulnerable form.
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
    // `-l -i -c` are meaningless to cmd.exe; emitting them was the original bug.
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
  // The win32 counterpart to the POSIX "single-quote-escapes a deck path" test.
  // An argv array is NOT a safety boundary when the executable is `cmd.exe`:
  // libuv joins argv into one command line quoting only values containing a
  // space, tab, or quote, and cmd.exe then re-parses that line under its own
  // grammar, where `&` separates commands. `a&calc.exe&b.md` has no space, so
  // it arrives unquoted and the second command runs.
  const evil = 'C:\\proj\\decks\\a&calc.exe&b.md';

  it('does not leave a live cmd.exe separator in the command line', () => {
    const inv = buildSlidevInvocation(
      { source: 'global', projectRoot: 'C:\\proj', docPath: evil, shell: '' },
      4300,
      'win32',
    );
    // The deck path must never appear as its own bare argv slot — that is the
    // shape cmd.exe splits on.
    expect(inv.args).not.toContain(evil);
    // `/s` strips exactly the outer quote pair and runs the remainder, so that
    // remainder is what cmd actually parses. Collapse its quoted spans; any
    // metacharacter still standing would be a live separator.
    const cmdline = inv.args[3] ?? '';
    expect(cmdline.startsWith('"') && cmdline.endsWith('"')).toBe(true);
    const parsedByCmd = cmdline.slice(1, -1);
    const unquoted = parsedByCmd.replace(/"[^"]*"/g, '');
    expect(unquoted).not.toMatch(/[&|<>^]/);
    // …and the path is still fully present inside its quoted span.
    expect(parsedByCmd).toContain(`"${evil}"`);
  });

  it('refuses a deck path carrying characters cmd.exe quoting cannot neutralize', () => {
    // `%` still expands inside double quotes and `"` cannot be quoted at all,
    // so these are refused at admission rather than escaped.
    expect(validateSpawnPath('C:\\proj\\%PATH%.md', 'win32')).toBe(false);
    expect(validateSpawnPath('C:\\proj\\a"b.md', 'win32')).toBe(false);
    // A legitimate name with `&` stays admissible — quoting handles it.
    expect(validateSpawnPath('C:\\proj\\Q1 & Q2.md', 'win32')).toBe(true);
  });
});
