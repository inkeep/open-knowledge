import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { waitWithinTestBudget } from '../wait-within-test-budget.test-helper.ts';
import {
  type HeldInstallRegistry,
  withHeldInstallRegistry,
} from './held-install-registry.test-helper.ts';
import {
  descendantsOf,
  entryOutcome,
  hasManifest,
  npxEntries,
  processEnded,
} from './npx-cache-entry.test-helper.ts';
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

function npmDebugLogs(home: string): string {
  const logs = join(home, 'npm-cache', '_logs');
  return existsSync(logs)
    ? readdirSync(logs)
        .filter((name) => name.endsWith('.log'))
        .map((name) => readFileSync(join(logs, name), 'utf8'))
        .join('\n')
    : '';
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
