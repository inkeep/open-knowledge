import type { McpEntryClassification } from '@inkeep/open-knowledge';
import { TERMINAL_CLI_IDS, TERMINAL_CLIS, type TerminalCli } from '@inkeep/open-knowledge-core';
import type { ClaudeReadiness, CliReadiness } from '../shared/bridge-contract.ts';
import { interactiveShellArgs } from '../shared/terminal-shell.ts';
import { windowsWherePathArgs } from '../shared/windows-env.ts';
import { getLogger } from './desktop-logger.ts';

export type ClaudeOnPath = ClaudeReadiness['claude'];
export type McpWiringStatus = ClaudeReadiness['mcp'];

export function cliProbeArgs(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return [...interactiveShellArgs(platform), '-c', `command -v ${bin}`];
}

export const CLAUDE_PROBE_ARGS: readonly string[] = cliProbeArgs('claude', process.platform);

const PROBE_TIMEOUT_MS = 5000;

export type McpEntryKind = McpEntryClassification['kind'];

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

interface InjectedProbeSpec {
  readonly spawn: ProbeSpawn;
  readonly file: string;
  readonly args: readonly string[];
  readonly timers: ProbeTimers;
  readonly timeoutMs: number;
  readonly loggerName: string;
  readonly label: string;
  readonly attrs: Record<string, unknown>;
}

function runInjectedProbe(spec: InjectedProbeSpec): Promise<number | null> {
  const { spawn, file, args, timers, timeoutMs, loggerName, label, attrs } = spec;
  return new Promise<number | null>((resolve) => {
    let child: ProbeChild;
    try {
      // biome-ignore lint/plugin/require-windowshide-on-spawn: injected probe seam; the production child_process adapter owns its spawn options
      child = spawn(file, args);
    } catch (err) {
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

export function interpretClaudeProbe(code: number | null): ClaudeOnPath {
  if (code === null) return 'unknown';
  return code === 0 ? 'present' : 'not-found';
}

export function mcpStatusFromClassification(kind: McpEntryKind): McpWiringStatus {
  return kind === 'present' ? 'wired' : 'needs-rewire';
}

export interface ResolveClaudeReadinessDeps {
  probeClaude(): Promise<number | null>;
  classifyMcpEntry(): McpEntryKind;
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
  probe(): Promise<number | null>;
  okServerConfigured?(): boolean;
}

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
  probe(cli: TerminalCli): Promise<number | null>;
}

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
  readonly probeWindows: (bin: string) => Promise<number | null>;
}

export interface ProbePlatformCliOnPathDeps extends ResolvePlatformCliInstalledMapDeps {
  readonly bin: string;
}

export function probePlatformCliOnPath(deps: ProbePlatformCliOnPathDeps): Promise<number | null> {
  if (deps.platform === 'win32') return deps.probeWindows(deps.bin);
  return deps.probePosix(cliProbeArgs(deps.bin, deps.platform));
}

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
