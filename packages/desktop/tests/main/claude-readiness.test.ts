import { TERMINAL_CLI_IDS, type TerminalCli } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CLAUDE_PROBE_ARGS,
  cliProbeArgs,
  interpretClaudeProbe,
  mcpStatusFromClassification,
  type ProbeChild,
  type ProbeTimers,
  probePlatformCliOnPath,
  resolveClaudeReadiness,
  resolveCliInstalledMap,
  resolveCliOnPath,
  resolvePlatformCliInstalledMap,
  runLoginShellProbe,
  runWindowsPathProbe,
} from '../../src/main/claude-readiness.ts';

const probeLog = vi.hoisted(() => {
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
vi.mock('../../src/main/desktop-logger.ts', () => ({ getLogger: () => probeLog }));

function operatorVisibleRecords(): unknown[][] {
  return [
    ...probeLog.fatal.mock.calls,
    ...probeLog.error.mock.calls,
    ...probeLog.warn.mock.calls,
    ...probeLog.info.mock.calls,
  ];
}

function makeFakeChild() {
  let exitCb: ((code: number | null) => void) | null = null;
  let errorCb: ((err: Error) => void) | null = null;
  let killed = false;
  const child: ProbeChild = {
    onExit: (cb) => {
      exitCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    child,
    emitExit: (code: number | null) => exitCb?.(code),
    emitError: (err: Error) => errorCb?.(err),
    wasKilled: () => killed,
  };
}

function makeFakeTimers() {
  let scheduled: (() => void) | null = null;
  let cleared = false;
  const timers: ProbeTimers = {
    setTimer: (cb) => {
      scheduled = cb;
      return 'token';
    },
    clearTimer: () => {
      cleared = true;
    },
  };
  return { timers, fireTimeout: () => scheduled?.(), wasCleared: () => cleared };
}

describe('interpretClaudeProbe', () => {
  test('exit 0 → present', () => {
    expect(interpretClaudeProbe(0)).toBe('present');
  });
  test('non-zero exit → not-found (command -v ran, claude absent)', () => {
    expect(interpretClaudeProbe(1)).toBe('not-found');
    expect(interpretClaudeProbe(127)).toBe('not-found');
  });
  test('null (probe could not run) → unknown, NOT not-found', () => {
    expect(interpretClaudeProbe(null)).toBe('unknown');
  });
});

describe('mcpStatusFromClassification', () => {
  test('present → wired', () => {
    expect(mcpStatusFromClassification('present')).toBe('wired');
  });
  test('absent / no-entry / decline → needs-rewire', () => {
    expect(mcpStatusFromClassification('absent')).toBe('needs-rewire');
    expect(mcpStatusFromClassification('no-entry')).toBe('needs-rewire');
    expect(mcpStatusFromClassification('decline')).toBe('needs-rewire');
  });
});

describe('cliProbeArgs', () => {
  test('matches each platform’s interactive PTY argv for any binary', () => {
    expect(cliProbeArgs('codex', 'darwin')).toEqual(['-l', '-i', '-c', 'command -v codex']);
    expect(cliProbeArgs('codex', 'linux')).toEqual(['-i', '-c', 'command -v codex']);
    expect(cliProbeArgs('cursor-agent', 'darwin')).toEqual([
      '-l',
      '-i',
      '-c',
      'command -v cursor-agent',
    ]);
    expect(CLAUDE_PROBE_ARGS).toEqual(cliProbeArgs('claude', process.platform));
  });
});

describe('runLoginShellProbe', () => {
  test('spawns the supplied shell with the platform command-v argv', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    let spawnedFile = '';
    let spawnedArgs: readonly string[] = [];
    const p = runLoginShellProbe(
      (file, args) => {
        spawnedFile = file;
        spawnedArgs = args;
        return child;
      },
      '/bin/zsh',
      timers,
    );
    emitExit(0);
    await p;
    expect(spawnedFile).toBe('/bin/zsh');
    expect(spawnedArgs).toEqual(CLAUDE_PROBE_ARGS);
  });

  test('honors a custom probe argv (per-CLI binary)', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    let spawnedArgs: readonly string[] = [];
    const p = runLoginShellProbe(
      (_file, args) => {
        spawnedArgs = args;
        return child;
      },
      'zsh',
      timers,
      undefined,
      cliProbeArgs('cursor-agent', 'darwin'),
    );
    emitExit(0);
    await p;
    expect(spawnedArgs).toEqual(['-l', '-i', '-c', 'command -v cursor-agent']);
  });

  test('resolves the child exit code and clears the timeout', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, wasCleared } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    emitExit(0);
    expect(await p).toBe(0);
    expect(wasCleared()).toBe(true);
  });

  test('a non-zero exit resolves that code (genuine not-found)', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    emitExit(1);
    expect(await p).toBe(1);
  });

  test("an async spawn 'error' resolves null (UNKNOWN, not absent)", async () => {
    const { child, emitError } = makeFakeChild();
    const { timers, wasCleared } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    emitError(new Error('spawn zsh ENOENT'));
    expect(await p).toBe(null);
    expect(wasCleared()).toBe(true);
  });

  test('a synchronous spawn throw (EMFILE/ENOMEM) resolves null', async () => {
    const { timers } = makeFakeTimers();
    const p = runLoginShellProbe(
      () => {
        throw new Error('spawn EMFILE');
      },
      'zsh',
      timers,
    );
    expect(await p).toBe(null);
  });

  test('a timeout kills the child and resolves null', async () => {
    const { child, wasKilled } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers, 5000);
    fireTimeout();
    expect(await p).toBe(null);
    expect(wasKilled()).toBe(true);
  });

  test('only the first signal wins (exit after timeout is ignored)', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    fireTimeout();
    emitExit(0);
    expect(await p).toBe(null);
  });
});

describe('runWindowsPathProbe', () => {
  test('spawns where.exe with the PATHEXT-aware $PATH: query for the binary', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    let spawnedFile = '';
    let spawnedArgs: readonly string[] = [];
    const p = runWindowsPathProbe(
      (file, args) => {
        spawnedFile = file;
        spawnedArgs = args;
        return child;
      },
      'C:\\Windows\\System32\\where.exe',
      'claude',
      timers,
    );
    emitExit(0);
    await p;
    expect(spawnedFile).toBe('C:\\Windows\\System32\\where.exe');
    expect(spawnedArgs).toEqual(['$PATH:claude']);
  });

  test('exit 0 resolves 0 and clears the timeout', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, wasCleared } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers);
    emitExit(0);
    expect(await p).toBe(0);
    expect(wasCleared()).toBe(true);
  });

  test('a non-zero exit resolves that code (where.exe ran; the binary is absent)', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'codex', timers);
    emitExit(1);
    expect(await p).toBe(1);
  });

  test("an async spawn 'error' resolves null (UNKNOWN, not absent)", async () => {
    const { child, emitError } = makeFakeChild();
    const { timers, wasCleared } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers);
    emitError(new Error('spawn where.exe ENOENT'));
    expect(await p).toBe(null);
    expect(wasCleared()).toBe(true);
  });

  test('a synchronous spawn throw resolves null (UNKNOWN, not absent)', async () => {
    const { timers } = makeFakeTimers();
    const p = runWindowsPathProbe(
      () => {
        throw new Error('spawn EMFILE');
      },
      'where.exe',
      'claude',
      timers,
    );
    expect(await p).toBe(null);
  });

  test('a wedged where.exe times out, is killed, and resolves null', async () => {
    const { child, wasKilled } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers, 5000);
    fireTimeout();
    expect(await p).toBe(null);
    expect(wasKilled()).toBe(true);
  });

  test('settles once — a late exit after the timeout does not overwrite UNKNOWN', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers);
    fireTimeout();
    emitExit(0);
    expect(await p).toBe(null);
  });

  test("settles once — an exit after an 'error' does not overwrite UNKNOWN", async () => {
    const { child, emitError, emitExit } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers);
    emitError(new Error('spawn where.exe EACCES'));
    emitExit(0);
    expect(await p).toBe(null);
  });
});

describe('windows probe verdict observability (an UNKNOWN must leave a trace)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a where.exe timeout emits an operator-visible record naming the failure class', async () => {
    const { child } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers, 5000);
    fireTimeout();
    expect(await p).toBe(null);
    const messages = operatorVisibleRecords().map((call) => call.map(String).join(' '));
    expect(messages.some((m) => /timed?\s*out/i.test(m))).toBe(true);
  });

  test("an async where.exe 'error' emits an operator-visible record carrying the cause", async () => {
    const { child, emitError } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers);
    const spawnFailure = new Error('spawn where.exe ENOENT');
    emitError(spawnFailure);
    expect(await p).toBe(null);
    expect(
      operatorVisibleRecords().some((call) =>
        call.some((arg) => (arg as { err?: unknown })?.err === spawnFailure),
      ),
    ).toBe(true);
  });

  test('a synchronous where.exe spawn throw emits an operator-visible record carrying the cause', async () => {
    const { timers } = makeFakeTimers();
    const spawnFailure = new Error('spawn EMFILE');
    const p = runWindowsPathProbe(
      () => {
        throw spawnFailure;
      },
      'where.exe',
      'claude',
      timers,
    );
    expect(await p).toBe(null);
    expect(
      operatorVisibleRecords().some((call) =>
        call.some((arg) => (arg as { err?: unknown })?.err === spawnFailure),
      ),
    ).toBe(true);
  });

  test('the logged attributes stay bounded-cardinality (registry bin, no free-form strings)', async () => {
    const { child } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runWindowsPathProbe(() => child, 'where.exe', 'claude', timers, 5000);
    fireTimeout();
    expect(await p).toBe(null);
    const attrs = operatorVisibleRecords()
      .flat()
      .find((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null);
    expect(attrs).toBeDefined();
    expect(attrs?.bin).toBe('claude');
    expect(Object.keys(attrs ?? {}).sort()).toEqual(['args', 'bin', 'timeoutMs', 'whereExe']);
  });
});

describe('probe verdict observability (an UNKNOWN must leave a trace)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a probe timeout emits an operator-visible log record naming the failure class', async () => {
    const { child } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers, 5000);
    fireTimeout();
    expect(await p).toBe(null);
    const records = operatorVisibleRecords();
    expect(records.length).toBeGreaterThan(0);
    const messages = records.map((call) => call.map(String).join(' '));
    expect(messages.some((m) => /timed?\s*out/i.test(m))).toBe(true);
  });

  test("an async spawn 'error' emits an operator-visible log record carrying the cause", async () => {
    const { child, emitError } = makeFakeChild();
    const { timers } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    const spawnFailure = new Error('spawn zsh ENOENT');
    emitError(spawnFailure);
    expect(await p).toBe(null);
    const records = operatorVisibleRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.some((call) => call.some((arg) => (arg as { err?: unknown })?.err === spawnFailure)),
    ).toBe(true);
  });

  test('a synchronous spawn throw emits an operator-visible log record carrying the cause', async () => {
    const { timers } = makeFakeTimers();
    const spawnFailure = new Error('spawn EMFILE');
    const p = runLoginShellProbe(
      () => {
        throw spawnFailure;
      },
      'zsh',
      timers,
    );
    expect(await p).toBe(null);
    const records = operatorVisibleRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.some((call) => call.some((arg) => (arg as { err?: unknown })?.err === spawnFailure)),
    ).toBe(true);
  });
});

describe('resolveClaudeReadiness', () => {
  test("claude present + mcp wired + project entry is OK's own → pre-approvable", async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(0),
      classifyMcpEntry: () => 'present',
      isProjectMcpPreApprovable: () => true,
    });
    expect(r).toEqual({ claude: 'present', mcp: 'wired', mcpPreApprovable: true });
  });

  test('claude not-found + mcp missing → needs-rewire, not pre-approvable', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(1),
      classifyMcpEntry: () => 'no-entry',
      isProjectMcpPreApprovable: () => false,
    });
    expect(r).toEqual({ claude: 'not-found', mcp: 'needs-rewire', mcpPreApprovable: false });
  });

  test('project pre-approval is independent of global wiring (foreign project entry → false)', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(0),
      classifyMcpEntry: () => 'present',
      isProjectMcpPreApprovable: () => false,
    });
    expect(r).toEqual({ claude: 'present', mcp: 'wired', mcpPreApprovable: false });
  });

  test('probe-null surfaces as claude unknown (mcp still resolves)', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(null),
      classifyMcpEntry: () => 'present',
      isProjectMcpPreApprovable: () => true,
    });
    expect(r).toEqual({ claude: 'unknown', mcp: 'wired', mcpPreApprovable: true });
  });

  test('a rejected probe degrades to claude unknown, never crashes', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.reject(new Error('boom')),
      classifyMcpEntry: () => 'present',
      isProjectMcpPreApprovable: () => false,
    });
    expect(r.claude).toBe('unknown');
  });

  test('a throwing classify degrades to needs-rewire, never crashes', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(0),
      classifyMcpEntry: () => {
        throw new Error('claude.json read blew up');
      },
      isProjectMcpPreApprovable: () => false,
    });
    expect(r).toEqual({ claude: 'present', mcp: 'needs-rewire', mcpPreApprovable: false });
  });

  test('a throwing isProjectMcpPreApprovable degrades to not pre-approvable, never crashes', async () => {
    const r = await resolveClaudeReadiness({
      probeClaude: () => Promise.resolve(0),
      classifyMcpEntry: () => 'present',
      isProjectMcpPreApprovable: () => {
        throw new Error('project .mcp.json read blew up');
      },
    });
    expect(r).toEqual({ claude: 'present', mcp: 'wired', mcpPreApprovable: false });
  });
});

describe('resolveCliOnPath', () => {
  test('exit 0 → on-PATH present', async () => {
    expect(await resolveCliOnPath({ probe: () => Promise.resolve(0) })).toEqual({
      onPath: 'present',
    });
  });

  test('non-zero exit → not-found', async () => {
    expect(await resolveCliOnPath({ probe: () => Promise.resolve(127) })).toEqual({
      onPath: 'not-found',
    });
  });

  test('probe-null → unknown (flaky probe is not a definitive not-found)', async () => {
    expect(await resolveCliOnPath({ probe: () => Promise.resolve(null) })).toEqual({
      onPath: 'unknown',
    });
  });

  test('a rejected probe degrades to unknown, never crashes', async () => {
    expect(await resolveCliOnPath({ probe: () => Promise.reject(new Error('boom')) })).toEqual({
      onPath: 'unknown',
    });
  });

  test('folds okServerConfigured when the codex-only dep is supplied', async () => {
    expect(
      await resolveCliOnPath({ probe: () => Promise.resolve(0), okServerConfigured: () => true }),
    ).toEqual({ onPath: 'present', okServerConfigured: true });
    expect(
      await resolveCliOnPath({ probe: () => Promise.resolve(0), okServerConfigured: () => false }),
    ).toEqual({ onPath: 'present', okServerConfigured: false });
  });

  test('a throwing okServerConfigured dep degrades to false (never fails the probe)', async () => {
    expect(
      await resolveCliOnPath({
        probe: () => Promise.resolve(0),
        okServerConfigured: () => {
          throw new Error('codex config read blew up');
        },
      }),
    ).toEqual({ onPath: 'present', okServerConfigured: false });
  });
});

describe('resolveCliInstalledMap', () => {
  test('maps definitive probe exit codes: 0 → installed, non-zero → not installed', async () => {
    const codes: Record<TerminalCli, number> = {
      claude: 0,
      codex: 127,
      copilot: 0,
      opencode: 127,
      cursor: 0,
      pi: 127,
      antigravity: 0,
      openclaw: 0,
      hermes: 127,
    };
    expect(await resolveCliInstalledMap({ probe: (cli) => Promise.resolve(codes[cli]) })).toEqual({
      claude: true,
      codex: false,
      copilot: true,
      opencode: false,
      cursor: true,
      pi: false,
      antigravity: true,
      openclaw: true,
      hermes: false,
    });
  });

  test('a probe-null (UNKNOWN) entry is not collapsed into positive absence', async () => {
    const map = await resolveCliInstalledMap({
      probe: (cli) => Promise.resolve(cli === 'pi' ? null : cli === 'codex' ? 127 : 0),
    });
    expect(map.claude).toBe(true);
    expect(map.codex).toBe(false);
    expect('pi' in map).toBe(false);
  });

  test('a rejected probe entry degrades to UNKNOWN — never positive absence — and never crashes', async () => {
    const map = await resolveCliInstalledMap({
      probe: (cli) => (cli === 'codex' ? Promise.reject(new Error('boom')) : Promise.resolve(0)),
    });
    expect(map.claude).toBe(true);
    expect('codex' in map).toBe(false);
  });

  test('all probes failing yields an empty map, not a map of explicit undefineds', async () => {
    const map = await resolveCliInstalledMap({ probe: () => Promise.resolve(null) });
    expect(Object.keys(map)).toHaveLength(0);
  });

  test('all-definitive probes yield one entry per CLI in TERMINAL_CLI_IDS', async () => {
    const map = await resolveCliInstalledMap({ probe: () => Promise.resolve(127) });
    expect(Object.keys(map).sort()).toEqual([...TERMINAL_CLI_IDS].sort());
  });
});

describe('probePlatformCliOnPath', () => {
  test('Windows uses the PATHEXT-aware native probe and never builds POSIX argv', async () => {
    const probePosix = vi.fn(async () => 0);
    const probeWindows = vi.fn(async (bin: string) => (bin === 'claude' ? 0 : 1));

    await expect(
      probePlatformCliOnPath({
        platform: 'win32',
        bin: 'claude',
        probePosix,
        probeWindows,
      }),
    ).resolves.toBe(0);
    await expect(
      probePlatformCliOnPath({
        platform: 'win32',
        bin: 'codex',
        probePosix,
        probeWindows,
      }),
    ).resolves.toBe(1);

    expect(probeWindows).toHaveBeenCalledWith('claude');
    expect(probeWindows).toHaveBeenCalledWith('codex');
    expect(probePosix).not.toHaveBeenCalled();
  });

  test('Windows passes an UNKNOWN through as null, never collapsing it to a not-found code', async () => {
    await expect(
      probePlatformCliOnPath({
        platform: 'win32',
        bin: 'claude',
        probePosix: vi.fn(async () => 0),
        probeWindows: vi.fn(async () => null),
      }),
    ).resolves.toBe(null);
  });

  test('macOS and Linux preserve their interactive command-v argv', async () => {
    const probePosix = vi.fn(async () => 0);
    const probeWindows = vi.fn(async () => 1);

    await probePlatformCliOnPath({
      platform: 'darwin',
      bin: 'claude',
      probePosix,
      probeWindows,
    });
    await probePlatformCliOnPath({
      platform: 'linux',
      bin: 'cursor-agent',
      probePosix,
      probeWindows,
    });

    expect(probeWindows).not.toHaveBeenCalled();
    expect(probePosix).toHaveBeenNthCalledWith(1, cliProbeArgs('claude', 'darwin'));
    expect(probePosix).toHaveBeenNthCalledWith(2, cliProbeArgs('cursor-agent', 'linux'));
  });
});

describe('resolvePlatformCliInstalledMap', () => {
  test('Windows resolves registry binaries with the native PATH probe', async () => {
    const probePosix = vi.fn(async () => 127);
    const probeWindows = vi.fn(async (bin: string) => (bin === 'codex' ? 0 : 1));

    const map = await resolvePlatformCliInstalledMap({
      platform: 'win32',
      probePosix,
      probeWindows,
    });

    expect(map.codex).toBe(true);
    expect(map.cursor).toBe(false);
    expect(probePosix).not.toHaveBeenCalled();
    expect(probeWindows).toHaveBeenCalledWith('codex');
    expect(probeWindows).toHaveBeenCalledWith('cursor-agent');
  });

  test('an unverifiable Windows probe omits the entry rather than caching a false negative', async () => {
    const map = await resolvePlatformCliInstalledMap({
      platform: 'win32',
      probePosix: vi.fn(async () => 0),
      probeWindows: vi.fn(async (bin: string) => (bin === 'claude' ? null : 1)),
    });

    expect('claude' in map).toBe(false);
    expect(map.codex).toBe(false);
  });

  test('macOS probes with the login-interactive shell argv', async () => {
    const probePosix = vi.fn(async (args: readonly string[]) =>
      args.at(-1) === 'command -v cursor-agent' ? 0 : 127,
    );
    const probeWindows = vi.fn(async () => 1);

    const map = await resolvePlatformCliInstalledMap({
      platform: 'darwin',
      probePosix,
      probeWindows,
    });

    expect(map.cursor).toBe(true);
    expect(map.codex).toBe(false);
    expect(probeWindows).not.toHaveBeenCalled();
    expect(probePosix).toHaveBeenCalledWith(cliProbeArgs('cursor-agent', 'darwin'));
  });

  test('Linux probes with the same non-login interactive argv as its PTY', async () => {
    const probed: readonly string[][] = [];
    const probePosix = vi.fn(async (args: readonly string[]) => {
      (probed as string[][]).push([...args]);
      return 127;
    });

    await resolvePlatformCliInstalledMap({
      platform: 'linux',
      probePosix,
      probeWindows: vi.fn(async () => 1),
    });

    expect(probed).toContainEqual(['-i', '-c', 'command -v claude']);
    expect(probed).toContainEqual(['-i', '-c', 'command -v cursor-agent']);
  });
});
