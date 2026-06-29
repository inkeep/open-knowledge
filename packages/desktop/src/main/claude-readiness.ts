import type { ClaudeReadiness, CliReadiness } from '../shared/bridge-contract.ts';
import { getLogger } from './desktop-logger.ts';

export type ClaudeOnPath = ClaudeReadiness['claude'];
export type McpWiringStatus = ClaudeReadiness['mcp'];

export function cliProbeArgs(bin: string): readonly string[] {
  return ['-l', '-i', '-c', `command -v ${bin}`];
}

/** The `claude` probe argv — `cliProbeArgs('claude')`, named for the legacy
 *  readiness path + its unit tests. */
export const CLAUDE_PROBE_ARGS: readonly string[] = cliProbeArgs('claude');

const PROBE_TIMEOUT_MS = 5000;

export type McpEntryKind = 'present' | 'absent' | 'no-entry' | 'corrupt';

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

export function interpretClaudeProbe(code: number | null): ClaudeOnPath {
  if (code === null) return 'unknown';
  return code === 0 ? 'present' : 'not-found';
}

/** Only an actually-present `open-knowledge` entry counts as wired; absent /
 *  no-entry / corrupt all mean the terminal's `claude` would see no OK tools. */
export function mcpStatusFromClassification(kind: McpEntryKind): McpWiringStatus {
  return kind === 'present' ? 'wired' : 'needs-rewire';
}

export interface ResolveClaudeReadinessDeps {
  probeClaude(): Promise<number | null>;
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
