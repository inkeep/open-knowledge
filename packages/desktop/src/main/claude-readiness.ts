/**
 * Claude Code readiness for the docked terminal.
 *
 * Two facts make typing `claude` "just work" inside the terminal:
 *   1. `claude` resolves on the interactive shell's PATH (so the user gets a real
 *      Claude Code, not "command not found").
 *   2. `~/.claude.json` carries the `open-knowledge` MCP server (so that
 *      `claude` already sees OK tools — the once-per-Mac MCP consent may have
 *      been skipped or raced, leaving a `claude` with no tools).
 *
 * This module computes both. The PATH check is a one-shot interactive-shell
 * probe, matching the PTY's platform argv (`-l -i` on macOS, `-i` on Linux),
 * with the `spawn` and timer injected so the probe's
 * timeout/exit-code/error logic is unit-testable without a real subprocess.
 * The MCP check reuses the CLI's `classifyExistingMcpEntry` (passed in by the
 * caller as a thunk over `~/.claude.json`).
 *
 * Electron-free by construction — no `electron` import, every effect injected —
 * so the routing logic runs under Vitest. The real subprocess + the real
 * `~/.claude.json` read are the runtime e2e rung (a built terminal).
 */

import type { McpEntryClassification } from '@inkeep/open-knowledge';
import { TERMINAL_CLI_IDS, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import type { ClaudeReadiness, CliReadiness } from '../shared/bridge-contract.ts';
import { interactiveShellArgs } from '../shared/terminal-shell.ts';
import { windowsWherePathArgs } from '../shared/windows-env.ts';
import { getLogger } from './desktop-logger.ts';

export type ClaudeOnPath = ClaudeReadiness['claude'];
export type McpWiringStatus = ClaudeReadiness['mcp'];

/**
 * Probe argv for a given binary. Matches the PTY's interactive argv
 * (pty-host.ts) plus `-c` so the probe resolves `<bin>` against exactly the
 * PATH the terminal shell will have.
 * `command -v` is POSIX, exits 0 iff `<bin>` resolves. `<bin>` is a fixed
 * registry value (`TERMINAL_CLIS[*].bin`), never user input — no injection
 * surface.
 */
export function cliProbeArgs(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return [...interactiveShellArgs(platform), '-c', `command -v ${bin}`];
}

/** The `claude` probe argv — `cliProbeArgs('claude')`, named for the legacy
 *  readiness path + its unit tests. */
export const CLAUDE_PROBE_ARGS: readonly string[] = cliProbeArgs('claude', process.platform);

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

/** One platform's executable-lookup probe expressed against the injected
 *  spawn/timer seams. `attrs` are the bounded-cardinality log fields that
 *  identify the probe in an operator's log (fixed argv + registry values only —
 *  never a raw user path or free-form string). */
interface InjectedProbeSpec {
  readonly spawn: ProbeSpawn;
  readonly file: string;
  readonly args: readonly string[];
  readonly timers: ProbeTimers;
  readonly timeoutMs: number;
  readonly loggerName: string;
  /** Names the probe in each degradation message ("<label> PATH probe ..."). */
  readonly label: string;
  readonly attrs: Record<string, unknown>;
}

/**
 * The one settle-once/timeout/observability engine every platform's PATH probe
 * runs on. Resolves the child's exit code, or `null` when the probe could not
 * produce a verdict — a synchronous `spawn` throw (EMFILE/ENOMEM resource
 * exhaustion), an async `'error'` (ENOENT/EACCES on the probe binary), or a
 * timeout (a lookup that hung). `null` is deliberately distinct from a non-zero
 * exit: a non-zero exit means the lookup RAN and the binary is genuinely
 * absent, whereas `null` means the probe itself failed and the binary's
 * presence is UNKNOWN — the caller must not render a "not installed" message
 * off an UNKNOWN.
 *
 * Every `null` resolution logs at warn: these probes gate launch baking and the
 * installed-map row gating, and a silent degradation makes a field report of
 * "isn't installed" undiagnosable (genuine PATH loss and a probe flake would
 * otherwise leave identical artifacts).
 *
 * The timeout is unconditional, so a wedged lookup binary settles the promise
 * instead of leaving the readiness IPC awaiting forever.
 */
function runInjectedProbe(spec: InjectedProbeSpec): Promise<number | null> {
  const { spawn, file, args, timers, timeoutMs, loggerName, label, attrs } = spec;
  return new Promise<number | null>((resolve) => {
    let child: ProbeChild;
    try {
      // biome-ignore lint/plugin/require-windowshide-on-spawn: injected probe seam; the production child_process adapter owns its spawn options
      child = spawn(file, args);
    } catch (err) {
      // partial-failure boundary: spawn can throw synchronously on resource
      // exhaustion. Presence is UNKNOWN, not absent.
      getLogger(loggerName).warn(
        { ...attrs, err },
        `${label} PATH probe spawn threw; presence unknown`,
      );
      resolve(null);
      return;
    }
    let settled = false;
    const timer = timers.setTimer(() => {
      getLogger(loggerName).warn(
        { ...attrs, timeoutMs },
        `${label} PATH probe timed out; presence unknown`,
      );
      child.kill();
      finish(null);
    }, timeoutMs);
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      timers.clearTimer(timer);
      resolve(code);
    }
    child.onError((err) => {
      if (!settled) {
        getLogger(loggerName).warn(
          { ...attrs, err },
          `${label} PATH probe failed to run; presence unknown`,
        );
      }
      finish(null);
    });
    child.onExit((code) => finish(code));
  });
}

/**
 * Run the interactive-shell `command -v claude` probe. Tri-state per
 * {@link runInjectedProbe}: exit code, or `null` for UNKNOWN.
 */
export function runLoginShellProbe(
  spawn: ProbeSpawn,
  shell: string,
  timers: ProbeTimers,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  args: readonly string[] = CLAUDE_PROBE_ARGS,
): Promise<number | null> {
  return runInjectedProbe({
    spawn,
    file: shell,
    args,
    timers,
    timeoutMs,
    loggerName: 'interactive-shell-probe',
    label: 'interactive-shell',
    attrs: { shell, args },
  });
}

/** Windows `where.exe` counterpart to {@link runLoginShellProbe}. */
export function runWindowsPathProbe(
  spawn: ProbeSpawn,
  whereExe: string,
  bin: string,
  timers: ProbeTimers,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const args = windowsWherePathArgs(bin);
  return runInjectedProbe({
    spawn,
    file: whereExe,
    args,
    timers,
    timeoutMs,
    loggerName: 'windows-path-probe',
    label: 'where.exe',
    attrs: { whereExe, bin, args },
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
  /** Runs the interactive-shell PATH probe; resolves the exit code or `null`. */
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
  /** Tri-state PATH probe per {@link runInjectedProbe}. */
  probe(): Promise<number | null>;
  /** Codex-only: whether OK's MCP server is already configured in the user's
   *  codex config (gates the per-launch `-c` auto-approve override). Synchronous;
   *  a throw here degrades to `false` (treated as not configured) rather than
   *  failing the whole readiness probe. Omit for CLIs where it does not apply —
   *  the result then carries no `okServerConfigured`. */
  okServerConfigured?(): boolean;
}

/** Generic on-PATH readiness for a non-Claude agent CLI. */
export async function resolveCliOnPath(deps: ResolveCliOnPathDeps): Promise<CliReadiness> {
  const code = await deps.probe().catch((err) => {
    getLogger('cli-readiness').warn(
      { err },
      'cli PATH probe rejected; treating cli presence as unknown',
    );
    return null;
  });
  const onPath = interpretClaudeProbe(code);
  if (deps.okServerConfigured === undefined) return { onPath };
  let okServerConfigured = false;
  try {
    okServerConfigured = deps.okServerConfigured();
  } catch (err) {
    getLogger('cli-readiness').warn(
      { err },
      'okServerConfigured probe threw; treating the OK server as not configured',
    );
  }
  return { onPath, okServerConfigured };
}

export interface ResolveCliInstalledMapDeps {
  /** Tri-state PATH probe per {@link runInjectedProbe}. */
  probe(cli: TerminalCli): Promise<number | null>;
}

/** Batched CLI readiness; unknown probes are omitted from the installed map. */
export async function resolveCliInstalledMap(
  deps: ResolveCliInstalledMapDeps,
): Promise<Partial<Record<TerminalCli, boolean>>> {
  const entries = await Promise.all(
    TERMINAL_CLI_IDS.map(async (cli) => {
      const { onPath } = await resolveCliOnPath({ probe: () => deps.probe(cli) });
      return [cli, onPath] as const;
    }),
  );
  const map: Partial<Record<TerminalCli, boolean>> = {};
  for (const [cli, onPath] of entries) {
    if (onPath !== 'unknown') map[cli] = onPath === 'present';
  }
  return map;
}

export interface ResolvePlatformCliInstalledMapDeps {
  readonly platform: NodeJS.Platform;
  readonly probePosix: (args: readonly string[]) => Promise<number | null>;
  /** Windows tri-state executable lookup for one binary. */
  readonly probeWindows: (bin: string) => Promise<number | null>;
}

export interface ProbePlatformCliOnPathDeps extends ResolvePlatformCliInstalledMapDeps {
  readonly bin: string;
}

/** Probe one registered CLI with the host platform's executable lookup. */
export function probePlatformCliOnPath(deps: ProbePlatformCliOnPathDeps): Promise<number | null> {
  if (deps.platform === 'win32') return deps.probeWindows(deps.bin);
  return deps.probePosix(cliProbeArgs(deps.bin, deps.platform));
}

/**
 * Resolve every registered CLI against the host's real executable lookup.
 * Windows needs `where` so PATHEXT-backed `.cmd` launchers count; POSIX hosts
 * need the login shell because desktop processes do not inherit its PATH.
 */
export function resolvePlatformCliInstalledMap(
  deps: ResolvePlatformCliInstalledMapDeps,
): Promise<Partial<Record<TerminalCli, boolean>>> {
  return resolveCliInstalledMap({
    probe: async (cli) => {
      const bin = TERMINAL_CLIS[cli].bin;
      return probePlatformCliOnPath({ ...deps, bin });
    },
  });
}
