/**
 * Claude Code readiness for the docked terminal.
 *
 * Two facts make typing `claude` "just work" inside the terminal:
 *   1. `claude` resolves on the login shell's PATH (so the user gets a real
 *      Claude Code, not "command not found").
 *   2. `~/.claude.json` carries the `open-knowledge` MCP server (so that
 *      `claude` already sees OK tools — the once-per-Mac MCP consent may have
 *      been skipped or raced, leaving a `claude` with no tools).
 *
 * This module computes both. The PATH check is a one-shot login-shell probe
 * (`$SHELL -l -i -c 'command -v claude'`, matching the PTY's own
 * `$SHELL -l -i`), with the `spawn` and timer injected so the probe's
 * timeout/exit-code/error logic is unit-testable without a real subprocess.
 * The MCP check reuses the CLI's `classifyExistingMcpEntry` (passed in by the
 * caller as a thunk over `~/.claude.json`).
 *
 * Electron-free by construction — no `electron` import, every effect injected —
 * so the routing logic runs under `bun test`. The real subprocess + the real
 * `~/.claude.json` read are the runtime e2e rung (a built terminal).
 */

import type { McpEntryClassification } from '@inkeep/open-knowledge';
import { TERMINAL_CLI_IDS, type TerminalCli } from '@inkeep/open-knowledge-core';
import type { ClaudeReadiness, CliReadiness } from '../shared/bridge-contract.ts';
import { getLogger } from './desktop-logger.ts';

export type ClaudeOnPath = ClaudeReadiness['claude'];
export type McpWiringStatus = ClaudeReadiness['mcp'];

/**
 * Probe argv for a given binary. Matches the PTY's `$SHELL -l -i` (pty-host.ts)
 * plus `-c` so the probe resolves `<bin>` against exactly the PATH the
 * interactive shell will have (login + interactive profiles sourced).
 * `command -v` is POSIX, exits 0 iff `<bin>` resolves. `<bin>` is a fixed
 * registry value (`TERMINAL_CLIS[*].bin`), never user input — no injection
 * surface.
 */
export function cliProbeArgs(bin: string): readonly string[] {
  return ['-l', '-i', '-c', `command -v ${bin}`];
}

/** The `claude` probe argv — `cliProbeArgs('claude')`, named for the legacy
 *  readiness path + its unit tests. */
export const CLAUDE_PROBE_ARGS: readonly string[] = cliProbeArgs('claude');

const PROBE_TIMEOUT_MS = 5000;

/** The classifications `classifyExistingMcpEntry` can return — derived from the
 *  CLI's authoritative union so a new kind can't silently drift this copy. */
export type McpEntryKind = McpEntryClassification['kind'];

/** Minimal child-process surface the probe drives — injected so the spawn is a
 *  test seam. Custom method names avoid the EventEmitter overload friction of
 *  structurally matching `child_process.ChildProcess`. */
export interface ProbeChild {
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(): void;
}
export type ProbeSpawn = (file: string, args: readonly string[]) => ProbeChild;

export interface ProbeTimers {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(token: unknown): void;
}

/**
 * Run the login-shell `command -v claude` probe. Resolves the child's exit
 * code, or `null` when the probe could not produce a verdict — a synchronous
 * `spawn` throw (EMFILE/ENOMEM resource exhaustion), an async `'error'`
 * (ENOENT shell, EACCES), or a timeout (an interactive shell that hung). `null`
 * is deliberately distinct from a non-zero exit: a non-zero exit means
 * `command -v` ran and `claude` is genuinely absent, whereas `null` means the
 * probe itself failed and claude's presence is UNKNOWN — the caller must not
 * render a "not installed" message off an UNKNOWN.
 */
export function runLoginShellProbe(
  spawn: ProbeSpawn,
  shell: string,
  timers: ProbeTimers,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  args: readonly string[] = CLAUDE_PROBE_ARGS,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let child: ProbeChild;
    try {
      child = spawn(shell, args);
    } catch {
      // partial-failure boundary: spawn can throw synchronously on resource
      // exhaustion. Claude presence is UNKNOWN, not absent.
      resolve(null);
      return;
    }
    let settled = false;
    const timer = timers.setTimer(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      timers.clearTimer(timer);
      resolve(code);
    }
    child.onError(() => finish(null));
    child.onExit((code) => finish(code));
  });
}

/** Probe exit code → claude-on-PATH verdict. `null` (probe failed) → UNKNOWN. */
export function interpretClaudeProbe(code: number | null): ClaudeOnPath {
  if (code === null) return 'unknown';
  return code === 0 ? 'present' : 'not-found';
}

/** Only an actually-present `open-knowledge` entry counts as wired; absent /
 *  no-entry / decline all mean the terminal's `claude` would see no OK tools. */
export function mcpStatusFromClassification(kind: McpEntryKind): McpWiringStatus {
  return kind === 'present' ? 'wired' : 'needs-rewire';
}

export interface ResolveClaudeReadinessDeps {
  /** Runs the login-shell PATH probe; resolves the exit code or `null`. */
  probeClaude(): Promise<number | null>;
  /** `classifyExistingMcpEntry('claude', home).kind` over `~/.claude.json`. */
  classifyMcpEntry(): McpEntryKind;
  /** Whether the project's OWN `open-knowledge` `.mcp.json` entry is OK's
   *  canonical managed server (cli `isOwnManagedEntry`) — gates the docked
   *  terminal's Claude MCP pre-approval. Project-scoped, distinct from the
   *  user-global `classifyMcpEntry` read above. */
  isProjectMcpPreApprovable(): boolean;
}

export async function resolveClaudeReadiness(
  deps: ResolveClaudeReadinessDeps,
): Promise<ClaudeReadiness> {
  const code = await deps.probeClaude().catch((err) => {
    // The probe must never crash preflight, but a non-timeout failure here is
    // worth a breadcrumb — log before degrading to UNKNOWN.
    getLogger('claude-readiness').warn(
      { err },
      'claude PATH probe rejected; treating claude presence as unknown',
    );
    return null;
  });
  let kind: McpEntryKind;
  try {
    kind = deps.classifyMcpEntry();
  } catch (err) {
    // classifyExistingMcpEntry has a never-throws contract, but it crosses the
    // ~/.claude.json fs + JSON-parse boundary; a contract violation must
    // surface as not-wired (offer the affordance), never crash preflight. Log
    // the contract breach so it isn't invisible.
    getLogger('claude-readiness').warn(
      { err },
      'classifyMcpEntry threw (never-throws contract violated); treating MCP as not-wired',
    );
    kind = 'absent';
  }
  let mcpPreApprovable: boolean;
  try {
    mcpPreApprovable = deps.isProjectMcpPreApprovable();
  } catch (err) {
    // Same never-throws posture as classifyMcpEntry: a project `.mcp.json`
    // read/parse failure must degrade to "not pre-approvable" (Claude shows its
    // trust prompt), never crash preflight.
    getLogger('claude-readiness').warn(
      { err },
      'isProjectMcpPreApprovable threw; treating project MCP as not pre-approvable',
    );
    mcpPreApprovable = false;
  }
  return {
    claude: interpretClaudeProbe(code),
    mcp: mcpStatusFromClassification(kind),
    mcpPreApprovable,
  };
}

export interface ResolveCliOnPathDeps {
  /** Runs the login-shell PATH probe for the CLI's binary; resolves the exit
   *  code or `null` (probe failed → UNKNOWN). */
  probe(): Promise<number | null>;
}

/**
 * Generic on-PATH readiness for a non-Claude agent CLI (codex / cursor-agent).
 * Unlike {@link resolveClaudeReadiness} there is no MCP-wiring concept — these
 * CLIs ground via the OK MCP server configured in their own way — so the result
 * is purely the on-PATH verdict. Reuses {@link interpretClaudeProbe}: `null`
 * (probe failed) → `unknown`, so the caller never renders a false "not
 * installed" off a flaky probe.
 */
export async function resolveCliOnPath(deps: ResolveCliOnPathDeps): Promise<CliReadiness> {
  const code = await deps.probe().catch((err) => {
    getLogger('cli-readiness').warn(
      { err },
      'cli PATH probe rejected; treating cli presence as unknown',
    );
    return null;
  });
  return { onPath: interpretClaudeProbe(code) };
}

export interface ResolveCliInstalledMapDeps {
  /** Login-shell PATH probe for a CLI's registry binary; resolves the exit code
   *  or `null` (probe failed → UNKNOWN, treated here as not-installed). */
  probe(cli: TerminalCli): Promise<number | null>;
}

/**
 * Batched on-PATH readiness for every launchable CLI, collapsed to a plain
 * installed map (`present` ⇒ true; `not-found` and `unknown` ⇒ false). This is
 * the "which CLIs can I launch?" answer the New-chat default-CLI auto-pick needs
 * — one query instead of four separate {@link resolveCliOnPath} preflights.
 * Collapsing `unknown` to false is deliberate: defaulting must resolve to a
 * concrete CLI, and an undetectable CLI is not a safe auto-pick (the resolver's
 * final fallback is claude). Each entry still routes through
 * {@link resolveCliOnPath}, so a flaky or rejected probe degrades that one entry
 * without crashing the batch.
 */
export async function resolveCliInstalledMap(
  deps: ResolveCliInstalledMapDeps,
): Promise<Record<TerminalCli, boolean>> {
  const entries = await Promise.all(
    TERMINAL_CLI_IDS.map(async (cli) => {
      const { onPath } = await resolveCliOnPath({ probe: () => deps.probe(cli) });
      return [cli, onPath === 'present'] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<TerminalCli, boolean>;
}
