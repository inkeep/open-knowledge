import { type Config, lockAdvertisesUi, resolveLockDir } from '@inkeep/open-knowledge-server';
import { Command } from 'commander';
import { inspectLock, type LockState } from './lock-state.ts';

interface StatusEntry {
  name: 'server' | 'ui';
  state: LockState['status'];
  pid?: number;
  port?: number;
  startedAt?: string;
  host?: string;
  alive: boolean | 'unknown';
  servedByServer?: boolean;
}

interface StatusReport {
  server: StatusEntry;
  ui: StatusEntry;
}

export function buildStatusReport(server: LockState): StatusReport {
  const serverEntry = summarize('server', server);
  const uiEntry: StatusEntry =
    server.status === 'alive' && lockAdvertisesUi(server.lock)
      ? {
          name: 'ui',
          state: 'alive',
          pid: server.lock.pid,
          port: server.lock.port,
          startedAt: server.lock.startedAt,
          host: server.lock.hostname,
          alive: true,
          servedByServer: true,
        }
      : { name: 'ui', state: 'missing', alive: false };
  return { server: serverEntry, ui: uiEntry };
}

function summarize(name: 'server' | 'ui', state: LockState): StatusEntry {
  switch (state.status) {
    case 'missing':
      return { name, state: 'missing', alive: false };
    case 'corrupt':
      return { name, state: 'corrupt', alive: false };
    case 'foreign-host':
      return {
        name,
        state: 'foreign-host',
        pid: state.lock.pid,
        port: state.lock.port,
        startedAt: state.lock.startedAt,
        host: state.lock.hostname,
        alive: 'unknown',
      };
    case 'dead-pid':
      return {
        name,
        state: 'dead-pid',
        pid: state.lock.pid,
        port: state.lock.port,
        startedAt: state.lock.startedAt,
        host: state.lock.hostname,
        alive: false,
      };
    case 'alive':
      return {
        name,
        state: 'alive',
        pid: state.lock.pid,
        port: state.lock.port,
        startedAt: state.lock.startedAt,
        host: state.lock.hostname,
        alive: true,
      };
  }
}

export function renderStatusText(report: StatusReport): string {
  return `${renderEntry(report.server)}\n${renderEntry(report.ui)}`;
}

function renderEntry(entry: StatusEntry): string {
  const label = entry.name === 'server' ? 'server' : 'ui    ';
  if (entry.state === 'missing') {
    return `${label}  not running`;
  }
  if (entry.state === 'corrupt') {
    return `${label}  lock file corrupt — run \`ok clean\``;
  }
  if (entry.state === 'foreign-host') {
    return `${label}  foreign host (${entry.host}) pid=${entry.pid} port=${entry.port}`;
  }
  if (entry.state === 'dead-pid') {
    return `${label}  stale (dead pid=${entry.pid}) — run \`ok clean\``;
  }
  if (entry.servedByServer === true) {
    return `${label}  served by server  pid=${entry.pid} port=${entry.port}`;
  }
  return `${label}  alive  pid=${entry.pid} port=${entry.port} started=${entry.startedAt}`;
}

interface RunStatusDeps {
  lockDir: string;
  json?: boolean;
  inspect?: () => LockState;
  log?: (msg: string) => void;
}

export function runStatus(deps: RunStatusDeps): StatusReport {
  const inspect = deps.inspect ?? (() => inspectLock(deps.lockDir, 'server'));
  const log = deps.log ?? ((msg) => console.log(msg));
  const report = buildStatusReport(inspect());
  if (deps.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(renderStatusText(report));
  }
  return report;
}

export function statusCommand(getConfig: () => Config): Command {
  return new Command('status')
    .description('Show whether the server and UI are running for this project')
    .option('--json', 'Emit structured JSON instead of formatted text')
    .action((opts: { json?: boolean }) => {
      getConfig();
      const lockDir = resolveLockDir(process.cwd());
      runStatus({ lockDir, json: opts.json === true });
    });
}
