import { Command } from 'commander';
import pc from 'picocolors';
import {
  discoverLockDirs,
  extractOkBinaryPath,
  type ProcessUsage,
  processCommand,
  processUsage,
} from '../utils/process-scan.ts';
import { inspectLock, type LockState } from './lock-state.ts';

interface PsEntry {
  directory: string;
  server: {
    port: number;
    status: LockState['status'];
    pid: number;
    startedAt: string;
    usage: ProcessUsage | null;
  };
  ui: {
    port: number;
    status: LockState['status'];
    pid: number;
    startedAt: string;
    usage: ProcessUsage | null;
  } | null;
  hostname: string;
  lockPath: string;
  binary: string | null;
  command: string | null;
  isDesktop: boolean;
}

export function isDesktopCommand(command: string | null): boolean {
  if (command == null) return false;
  return (
    command.includes('--type=utility') &&
    command.includes('--utility-sub-type=node.mojom.NodeService')
  );
}

export function timeAgo(isoString: string, now = Date.now()): string {
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function buildEntry(
  _lockDir: string,
  serverState: LockState,
  uiState: LockState,
  command: string | null,
  serverUsage: ProcessUsage | null,
  uiUsage: ProcessUsage | null,
): PsEntry | null {
  if (serverState.status === 'missing' || serverState.status === 'corrupt') {
    return null;
  }

  const serverLock = serverState.lock;

  let ui: PsEntry['ui'] = null;
  if (uiState.status !== 'missing' && uiState.status !== 'corrupt') {
    const uiLock = uiState.lock;
    ui = {
      port: uiLock.port,
      status: uiState.status,
      pid: uiLock.pid,
      startedAt: uiLock.startedAt,
      usage: uiUsage,
    };
  }

  return {
    directory: serverLock.worktreeRoot,
    server: {
      port: serverLock.port,
      status: serverState.status,
      pid: serverLock.pid,
      startedAt: serverLock.startedAt,
      usage: serverUsage,
    },
    ui,
    hostname: serverLock.hostname,
    lockPath: serverState.lockPath,
    binary: command == null ? null : extractOkBinaryPath(command),
    command,
    isDesktop: isDesktopCommand(command),
  };
}

type DisplayStatus = 'running' | 'desktop' | 'foreign' | 'stale' | 'ui-orphan';

function isUiLive(entry: PsEntry): boolean {
  if (entry.ui == null) return false;
  return entry.ui.status === 'alive' || entry.ui.status === 'foreign-host';
}

function displayStatus(entry: PsEntry): DisplayStatus {
  const serverStatus = entry.server.status;
  if (serverStatus === 'alive' || serverStatus === 'foreign-host') {
    if (entry.isDesktop) return 'desktop';
    return serverStatus === 'alive' ? 'running' : 'foreign';
  }
  if (serverStatus === 'dead-pid' && isUiLive(entry)) return 'ui-orphan';
  return 'stale';
}

const DEFAULT_VISIBLE: ReadonlySet<DisplayStatus> = new Set([
  'running',
  'desktop',
  'foreign',
  'ui-orphan',
]);

function colorStatus(label: DisplayStatus): string {
  switch (label) {
    case 'running':
      return pc.green(label);
    case 'desktop':
      return pc.blue(label);
    case 'foreign':
      return pc.cyan(label);
    case 'ui-orphan':
      return pc.magenta(label);
    case 'stale':
      return pc.yellow(label);
  }
}

function formatUsage(usage: ProcessUsage | null): string {
  if (usage == null) return '—';
  return `${usage.cpuPercent.toFixed(1)}% / ${usage.memPercent.toFixed(1)}%`;
}

function formatCombinedUsage(entry: PsEntry): string {
  return `${formatUsage(entry.server.usage)} | ${formatUsage(entry.ui?.usage ?? null)}`;
}

function formatPorts(entry: PsEntry): string {
  const serverPort = entry.server.port === 0 ? '(starting)' : String(entry.server.port);
  const uiPort = entry.ui == null || entry.ui.status === 'dead-pid' ? '—' : String(entry.ui.port);
  return `${serverPort} / ${uiPort}`;
}

export function renderTable(entries: PsEntry[]): string {
  if (entries.length === 0) {
    return 'No open-knowledge servers found.';
  }

  const headers = [
    'DIRECTORY',
    'PORTS (API/UI)',
    'CPU/MEM (API | UI)',
    'STATUS',
    'PID',
    'STARTED',
    'BINARY',
  ];
  const rows = entries.map((e) => {
    const status = displayStatus(e);
    const pid = status === 'ui-orphan' && e.ui != null ? e.ui.pid : e.server.pid;
    return [
      e.directory,
      formatPorts(e),
      formatCombinedUsage(e),
      status,
      String(pid),
      timeAgo(e.server.startedAt),
      e.binary ?? '—',
    ];
  });

  const colCount = headers.length;
  const widths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i] ?? 0, (row[i] ?? '').length);
    }
  }

  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i] ?? 0))
    .join('  ')
    .trimEnd();

  const dataLines = entries.map((entry, rowIdx) => {
    const row = rows[rowIdx] ?? [];
    const cols: string[] = [];
    for (let i = 0; i < colCount; i++) {
      let cell = (row[i] ?? '').padEnd(widths[i] ?? 0);
      if (i === 3) {
        const rawCell = row[i] ?? '';
        const colored = colorStatus(displayStatus(entry));
        const padding = ' '.repeat(Math.max(0, (widths[i] ?? 0) - rawCell.length));
        cell = colored + padding;
      }
      cols.push(cell);
    }
    return cols.join('  ').trimEnd();
  });

  const hint = pc.dim('To stop a server: ok stop <port|pid|directory|all>');
  return [headerLine, ...dataLines, '', hint].join('\n');
}

interface RunPsDeps {
  discover?: () => Promise<string[]>;
  inspect?: (lockDir: string, name: 'server' | 'ui') => LockState;
  resolveCommand?: (pid: number) => string | null;
  resolveUsage?: (pid: number) => ProcessUsage | null;
  json?: boolean;
  all?: boolean;
  log?: (msg: string) => void;
}

export async function runPs(deps: RunPsDeps = {}): Promise<void> {
  const discover = deps.discover ?? discoverLockDirs;
  const inspect = deps.inspect ?? inspectLock;
  const log = deps.log ?? ((msg) => console.log(msg));
  const resolveCommand = deps.resolveCommand ?? processCommand;
  const resolveUsage = deps.resolveUsage ?? processUsage;

  const lockDirs = await discover();

  const entries: PsEntry[] = [];
  for (const lockDir of lockDirs) {
    const serverState = inspect(lockDir, 'server');
    const uiState = inspect(lockDir, 'ui');
    const command =
      serverState.status === 'missing' || serverState.status === 'corrupt'
        ? null
        : resolveCommand(serverState.lock.pid);
    const serverUsage =
      serverState.status === 'missing' || serverState.status === 'corrupt'
        ? null
        : resolveUsage(serverState.lock.pid);
    const uiUsage =
      uiState.status === 'missing' || uiState.status === 'corrupt'
        ? null
        : resolveUsage(uiState.lock.pid);
    const entry = buildEntry(lockDir, serverState, uiState, command, serverUsage, uiUsage);
    if (entry != null) {
      entries.push(entry);
    }
  }

  if (deps.json) {
    const enriched = entries.map((e) => ({ ...e, displayStatus: displayStatus(e) }));
    log(JSON.stringify(enriched, null, 2));
    return;
  }

  const filtered = deps.all
    ? entries
    : entries.filter((e) => DEFAULT_VISIBLE.has(displayStatus(e)));

  log(renderTable(filtered));
}

export function psCommand(): Command {
  return new Command('ps')
    .description('List all running open-knowledge servers')
    .argument('[modifier]', '"all" to include stale (dead-pid) entries')
    .option('--all', 'Include stale (dead-pid) entries (foreign-host shows by default)')
    .option('--json', 'Emit structured JSON (always includes all statuses)')
    .action(async (modifier: string | undefined, opts: { all?: boolean; json?: boolean }) => {
      const all = opts.all === true || modifier === 'all';
      await runPs({ all, json: opts.json === true });
    });
}
