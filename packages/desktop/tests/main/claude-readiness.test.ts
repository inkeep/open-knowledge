import { describe, expect, test } from 'bun:test';
import { TERMINAL_CLI_IDS, type TerminalCli } from '@inkeep/open-knowledge-core';
import {
  CLAUDE_PROBE_ARGS,
  cliProbeArgs,
  interpretClaudeProbe,
  mcpStatusFromClassification,
  type ProbeChild,
  type ProbeTimers,
  resolveClaudeReadiness,
  resolveCliInstalledMap,
  resolveCliOnPath,
  runLoginShellProbe,
} from '../../src/main/claude-readiness.ts';

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
    // A flaky probe must not masquerade as a definitive "not installed".
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
  test('builds the login-interactive `command -v <bin>` argv for any binary', () => {
    expect(cliProbeArgs('codex')).toEqual(['-l', '-i', '-c', 'command -v codex']);
    expect(cliProbeArgs('cursor-agent')).toEqual(['-l', '-i', '-c', 'command -v cursor-agent']);
    // The claude argv is just the generic builder applied to `claude`.
    expect(CLAUDE_PROBE_ARGS).toEqual(cliProbeArgs('claude'));
  });
});

describe('runLoginShellProbe', () => {
  test('spawns the supplied shell with the login-interactive command -v argv', async () => {
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
      cliProbeArgs('cursor-agent'),
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
    // Shell never exits — fire the injected timeout.
    fireTimeout();
    expect(await p).toBe(null);
    expect(wasKilled()).toBe(true);
  });

  test('only the first signal wins (exit after timeout is ignored)', async () => {
    const { child, emitExit } = makeFakeChild();
    const { timers, fireTimeout } = makeFakeTimers();
    const p = runLoginShellProbe(() => child, 'zsh', timers);
    fireTimeout();
    emitExit(0); // late — already settled to null
    expect(await p).toBe(null);
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
    // The supply-chain case: global ~/.claude.json is wired, but the PROJECT's
    // own `open-knowledge` entry is foreign, so pre-approval is withheld and
    // Claude's trust prompt stays in place.
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
});

describe('resolveCliInstalledMap', () => {
  test('maps each CLI probe exit code to installed=true iff the probe exited 0', async () => {
    // A distinct verdict per CLI: on-PATH (0), absent (127), flaky/unknown (null).
    const codes: Record<TerminalCli, number | null> = {
      claude: 0,
      codex: 127,
      opencode: null,
      cursor: 0,
    };
    expect(await resolveCliInstalledMap({ probe: (cli) => Promise.resolve(codes[cli]) })).toEqual({
      claude: true,
      codex: false,
      opencode: false,
      cursor: true,
    });
  });

  test('a rejected probe for one CLI degrades that entry to not-installed, never crashes', async () => {
    const map = await resolveCliInstalledMap({
      probe: (cli) => (cli === 'codex' ? Promise.reject(new Error('boom')) : Promise.resolve(0)),
    });
    expect(map).toEqual({ claude: true, codex: false, opencode: true, cursor: true });
  });

  test('returns exactly one entry per CLI in TERMINAL_CLI_IDS', async () => {
    const map = await resolveCliInstalledMap({ probe: () => Promise.resolve(127) });
    expect(Object.keys(map).sort()).toEqual([...TERMINAL_CLI_IDS].sort());
  });
});
