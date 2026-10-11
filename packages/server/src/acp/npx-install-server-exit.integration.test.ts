import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readProcessState } from '../process-scan.ts';
import { waitWithinTestBudget } from '../wait-within-test-budget.test-helper.ts';
import {
  type HeldInstallRegistry,
  withHeldInstallRegistry,
} from './held-install-registry.test-helper.ts';
import type { RegistryAgent } from './registry.ts';

const SERVER_PROCESS = fileURLToPath(
  new URL('./install-server-process.test-helper.ts', import.meta.url),
);

const WAIT = { timeoutMs: 60_000 };

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };

type ServerProcess = {
  child: ChildProcess;
  exited: () => boolean;
  exitStatus: () => ExitStatus | undefined;
  closed: () => boolean;
  output: () => string;
};

function startServerProcess(held: HeldInstallRegistry): ServerProcess {
  const agent: RegistryAgent = {
    id: 'held-install',
    name: 'Held install agent',
    version: '1.0.0',
    distribution: { npx: { package: held.npmPackage } },
  };
  const contentDir = mkdtempSync(join(held.home, 'content-'));
  const child = fork(SERVER_PROCESS, [contentDir, JSON.stringify(agent)], {
    execArgv: ['--import', 'tsx', '--conditions=@inkeep/source'],
    silent: true,
  });
  let output = '';
  let exitStatus: ExitStatus | undefined;
  let closed = false;
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.once('exit', (code, signal) => {
    exitStatus = { code, signal };
  });
  child.once('close', () => {
    closed = true;
  });
  return {
    child,
    exited: () => exitStatus !== undefined,
    exitStatus: () => exitStatus,
    closed: () => closed,
    output: () => output,
  };
}

function descendantsOf(root: number): number[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const kid of children.get(next) ?? []) {
      found.push(kid);
      queue.push(kid);
    }
  }
  return found;
}

function processEnded(pid: number): boolean {
  const state = readProcessState(pid, {
    onProbeFailure: ({ reason }) => {
      throw new Error(`could not read the state of process ${pid}: ${reason}`);
    },
  });
  return state.status === 'gone' || state.status === 'defunct';
}

function npxEntries(home: string): string[] {
  const npxCache = join(home, 'npm-cache', '_npx');
  return existsSync(npxCache) ? readdirSync(npxCache).map((name) => join(npxCache, name)) : [];
}

function installedPackages(entry: string): string[] {
  const modules = join(entry, 'node_modules');
  return existsSync(modules) ? readdirSync(modules).filter((name) => !name.startsWith('.')) : [];
}

function npmDebugLogs(home: string): string {
  const logs = join(home, 'npm-cache', '_logs');
  return existsSync(logs)
    ? readdirSync(logs)
        .filter((name) => name.endsWith('.log'))
        .map((name) => readFileSync(join(logs, name), 'utf8'))
        .join('\n')
    : '';
}

function hasManifest(dir: string): boolean {
  return existsSync(join(dir, 'package.json'));
}

function entryOutcome(entry: string, agentName: string) {
  const packages = installedPackages(entry);
  const modules = join(entry, 'node_modules');
  const agentDir = join(modules, agentName);
  const agentDependencies = hasManifest(agentDir)
    ? Object.keys(
        (
          JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
          }
        ).dependencies ?? {},
      )
    : [];
  const snapshot = {
    rootManifest: hasManifest(entry),
    lock: existsSync(join(entry, 'concurrency.lock')),
    packages,
    withoutManifest: packages.filter((name) => !hasManifest(join(modules, name))),
  };
  const complete =
    snapshot.rootManifest &&
    !snapshot.lock &&
    hasManifest(agentDir) &&
    agentDependencies.every((name) => hasManifest(join(modules, name))) &&
    snapshot.withoutManifest.length === 0;
  const rolledBack = !snapshot.rootManifest && !snapshot.lock && packages.length === 0;
  const state = complete ? 'complete' : rolledBack ? 'rolled-back' : 'partial';
  return { state, ...snapshot };
}

const SERVER_ENDINGS = [
  { ending: 'shuts down on SIGTERM', signal: 'SIGTERM', exit: { code: 0, signal: null } },
  { ending: 'is killed', signal: 'SIGKILL', exit: { code: null, signal: 'SIGKILL' } },
] as const;

describe.skipIf(process.platform === 'win32')(
  'an npx install that outlives the server process that started it',
  () => {
    test.each(SERVER_ENDINGS)(
      'the npx cache entry ends complete or rolled back when the server $ending mid-install',
      async ({ signal, exit }) => {
        expect(
          () => descendantsOf(process.pid),
          'this test reads the process table with ps',
        ).not.toThrow();
        await withHeldInstallRegistry(
          async (held) => {
            const agentName = held.npmPackage.slice(0, held.npmPackage.lastIndexOf('@'));
            const server = startServerProcess(held);
            let outliving: number[] = [];
            try {
              await waitWithinTestBudget(
                'the server to start installing the agent package',
                () => {
                  if (server.exited()) {
                    throw new Error(`the server process exited early: ${server.output()}`);
                  }
                  return held.requested('npm-dependency') > 0;
                },
                WAIT,
              );
              const entries = npxEntries(held.home);
              expect(entries).toHaveLength(1);
              const entry = String(entries[0]);
              expect(hasManifest(entry)).toBe(false);
              const serverPid = server.child.pid;
              if (serverPid === undefined) throw new Error('the server process has no pid');
              outliving = descendantsOf(serverPid);
              expect(outliving.length).toBeGreaterThan(0);

              server.child.kill(signal);
              await waitWithinTestBudget('the server process to exit', server.exited, WAIT);
              held.release('npm-dependency');
              await waitWithinTestBudget(
                'every process the server started to exit',
                () => outliving.every(processEnded),
                WAIT,
              );
              await waitWithinTestBudget('the server process output to close', server.closed, WAIT);
              expect(server.exitStatus(), server.output()).toEqual(exit);

              expect(
                npmDebugLogs(held.home),
                'npm wrote its deprecation warning after the server ended',
              ).toMatch(/warn deprecated \S*ok-held-install-dependency/);
              const outcome = entryOutcome(entry, agentName);
              expect(['complete', 'rolled-back'], JSON.stringify(outcome)).toContain(outcome.state);
            } finally {
              try {
                if (!server.exited() && outliving.length === 0 && server.child.pid !== undefined) {
                  outliving = descendantsOf(server.child.pid);
                }
              } finally {
                if (!server.exited()) {
                  server.child.kill('SIGKILL');
                  await waitWithinTestBudget('the server process to exit', server.exited, WAIT);
                }
                held.release('npm-dependency');
                await waitWithinTestBudget(
                  'every process the server started to exit',
                  () => outliving.every(processEnded),
                  WAIT,
                );
              }
            }
          },
          { dependencyDeprecated: 'this dependency is no longer maintained' },
        );
      },
      150_000,
    );
  },
);
