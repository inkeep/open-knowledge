import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ThreadEvent,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { readProcessState } from '../process-scan.ts';
import { waitWithinTestBudget } from '../wait-within-test-budget.test-helper.ts';
import { AGENT_BROWSER_MCP_PACKAGE } from './browser-mcp.ts';
import {
  type HeldInstallRegistry,
  withHeldInstallRegistry,
} from './held-install-registry.test-helper.ts';
import { resetAcquisitionCache } from './launch.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry, type RegistryAgent } from './registry.ts';
import { AcpThreadManager } from './thread-manager.ts';

const log = getLogger('browser-install-teardown-test');

const WAIT = { timeoutMs: 60_000 };
const TARBALL_ARRIVES_AFTER_MS = 10_000;
const BROWSER_NAME = AGENT_BROWSER_MCP_PACKAGE.slice(0, AGENT_BROWSER_MCP_PACKAGE.lastIndexOf('@'));

const sessionManager = {
  getSession: async () => {
    throw new Error('the held agent never uses client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

function browserManager(held: HeldInstallRegistry): AcpThreadManager {
  const localDir = mkdtempSync(join(held.home, 'local-'));
  const contentDir = mkdtempSync(join(held.home, 'content-'));
  const agent: RegistryAgent = {
    id: 'claude-acp',
    name: 'Claude Code',
    version: '1.0.0',
    distribution: { npx: { package: held.npmPackage } },
  };
  return new AcpThreadManager({
    contentDir,
    localDir,
    globalDir: mkdtempSync(join(held.home, 'global-')),
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => new Response(JSON.stringify({ agents: [agent] }))) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    log,
    resolveLoginShellPath: async () => null,
    projectSkillSourceDir: null,
    agentBrowserTools: () => true,
  });
}

function descendantsOf(root: number): number[] {
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (ps.error !== undefined) throw ps.error;
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid) || pid === ps.pid) {
      continue;
    }
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

function hasManifest(dir: string): boolean {
  return existsSync(join(dir, 'package.json'));
}

function browserEntry(home: string): string | undefined {
  return npxEntries(home).find((entry) => {
    const manifest = join(entry, 'package.json');
    if (!existsSync(manifest)) return false;
    try {
      const { dependencies = {} } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      return BROWSER_NAME in dependencies;
    } catch {
      return false;
    }
  });
}

function entryOutcome(entry: string) {
  const modules = join(entry, 'node_modules');
  const packages = existsSync(modules)
    ? readdirSync(modules)
        .filter((name) => !name.startsWith('.'))
        .flatMap((name) =>
          name.startsWith('@')
            ? readdirSync(join(modules, name)).map((scoped) => `${name}/${scoped}`)
            : [name],
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
    packages.includes(BROWSER_NAME) &&
    snapshot.withoutManifest.length === 0;
  const rolledBack = !snapshot.rootManifest && !snapshot.lock && packages.length === 0;
  return {
    state: complete ? 'complete' : rolledBack ? 'rolled-back' : 'partial',
    ...snapshot,
  };
}

function relayStartedFrom(entry: string): boolean {
  return existsSync(join(entry, 'node_modules', BROWSER_NAME, 'started'));
}

function collect(into: ThreadEvent[]) {
  return (frame: ThreadServerFrame): void => {
    if (frame.op === 'event') into.push(frame.event);
    if (frame.op === 'events') into.push(...frame.events);
  };
}

const TEARDOWNS = [
  {
    teardown: 'the chat is closed',
    run: (manager: AcpThreadManager, threadId: string) => manager.closeThread(threadId),
  },
  {
    teardown: 'the server shuts its chats down',
    run: (manager: AcpThreadManager) => manager.destroy(),
  },
] as const;

describe.skipIf(process.platform === 'win32')(
  "the agent browser's npx package and chat teardown",
  () => {
    test.each(TEARDOWNS)(
      'the browser npx cache entry ends complete or rolled back when $teardown mid-install',
      async ({ run }) => {
        await withHeldInstallRegistry(async (held) => {
          held.release('npm-dependency');
          const preexisting = new Set(descendantsOf(process.pid));
          const started = new Set<number>();
          const liveSinceStart = (): number[] => {
            const live = descendantsOf(process.pid).filter((pid) => !preexisting.has(pid));
            for (const pid of live) started.add(pid);
            return live;
          };
          const everyStartedProcessEnded = (): boolean =>
            liveSinceStart().length === 0 && [...started].every(processEnded);
          resetAcquisitionCache();
          const manager = browserManager(held);
          try {
            const { threadId } = await manager.createThread({
              agent: { source: 'registry', id: 'claude-acp' },
            });
            await waitWithinTestBudget(
              "npm to request the browser package's held dependency mid-install",
              () => {
                liveSinceStart();
                const status = manager.getInfo(threadId)?.status;
                if (status === 'error' || status === 'exited') {
                  throw new Error(`the chat settled as ${status} before npm reached the tarball`);
                }
                return held.requested('browser-dependency') === 1;
              },
              WAIT,
            );
            const installing = npxEntries(held.home).filter((entry) => !hasManifest(entry));
            expect(
              installing,
              'npm is installing the browser when the teardown begins',
            ).toHaveLength(1);
            const entry = String(installing[0]);

            let teardownSettled = false;
            const teardownStartedAt = Date.now();
            const teardown = run(manager, threadId).finally(() => {
              teardownSettled = true;
            });
            await waitWithinTestBudget(
              'the teardown to settle or the held tarball to outlast every teardown grace',
              () => {
                liveSinceStart();
                return (
                  teardownSettled || Date.now() - teardownStartedAt >= TARBALL_ARRIVES_AFTER_MS
                );
              },
              { timeoutMs: TARBALL_ARRIVES_AFTER_MS + 5_000 },
            );
            held.release('browser-dependency');
            await teardown;
            await waitWithinTestBudget(
              'every process the chat started to exit',
              everyStartedProcessEnded,
              WAIT,
            );

            const outcome = entryOutcome(entry);
            expect(['complete', 'rolled-back'], JSON.stringify(outcome)).toContain(outcome.state);
          } finally {
            held.release('browser-dependency');
            await manager.destroy();
            await waitWithinTestBudget(
              'every process the test started to exit',
              everyStartedProcessEnded,
              WAIT,
            );
          }
        });
      },
      150_000,
    );

    test('a chat repairs a browser entry an earlier teardown left without its manifest', async () => {
      await withHeldInstallRegistry(async (held) => {
        held.release('npm-dependency');
        held.release('browser-dependency');
        resetAcquisitionCache();
        let manager = browserManager(held);
        try {
          const first = await manager.createThread({
            agent: { source: 'registry', id: 'claude-acp' },
          });
          await waitWithinTestBudget(
            'the first chat to start with its browser installed',
            () => {
              const entry = browserEntry(held.home);
              return (
                manager.getInfo(first.threadId)?.status === 'ready' &&
                entry !== undefined &&
                entryOutcome(entry).state === 'complete' &&
                relayStartedFrom(entry)
              );
            },
            WAIT,
          );
          await manager.destroy();
          const entry = browserEntry(held.home);
          if (entry === undefined) throw new Error('the first chat installed no browser entry');
          rmSync(join(entry, 'node_modules', BROWSER_NAME, 'started'));
          rmSync(join(entry, 'package.json'));
          rmSync(join(entry, 'node_modules', 'ok-held-install-browser-dependency', 'package.json'));

          manager = browserManager(held);
          const second = await manager.createThread({
            agent: { source: 'registry', id: 'claude-acp' },
          });
          const events: ThreadEvent[] = [];
          await manager.subscribe(second.threadId, 0, collect(events));
          await waitWithinTestBudget(
            'the second chat to start and its browser to run from the repaired entry',
            () => manager.getInfo(second.threadId)?.status === 'ready' && relayStartedFrom(entry),
            WAIT,
          );
          expect(entryOutcome(entry).state).toBe('complete');
          expect(events.filter((event) => event.kind === 'browser_unavailable')).toEqual([]);

          rmSync(entry, { recursive: true, force: true });
          const third = await manager.createThread({
            agent: { source: 'registry', id: 'claude-acp' },
          });
          await waitWithinTestBudget(
            'a chat started after the whole browser entry was deleted, with its browser running from the rebuilt entry',
            () => manager.getInfo(third.threadId)?.status === 'ready' && relayStartedFrom(entry),
            WAIT,
          );
          expect(entryOutcome(entry).state).toBe('complete');
        } finally {
          await manager.destroy();
        }
      });
    }, 150_000);

    test("a chat installs the browser when npm's cached package data predates the pinned version", async () => {
      await withHeldInstallRegistry(async (held) => {
        held.release('npm-dependency');
        held.release('browser-dependency');
        held.publishBrowser(false);
        resetAcquisitionCache();
        const manager = browserManager(held);
        try {
          const stale = await manager.createThread({
            agent: { source: 'registry', id: 'claude-acp' },
          });
          const staleEvents: ThreadEvent[] = [];
          await manager.subscribe(stale.threadId, 0, collect(staleEvents));
          await waitWithinTestBudget(
            'a chat to start without the browser while the pinned version is unpublished',
            () =>
              manager.getInfo(stale.threadId)?.status === 'ready' &&
              staleEvents.some((event) => event.kind === 'browser_unavailable'),
            WAIT,
          );

          held.publishBrowser(true);
          const fresh = await manager.createThread({
            agent: { source: 'registry', id: 'claude-acp' },
          });
          const events: ThreadEvent[] = [];
          await manager.subscribe(fresh.threadId, 0, collect(events));
          await waitWithinTestBudget(
            'a chat to start with the browser once the pinned version is published',
            () => {
              const entry = browserEntry(held.home);
              return (
                manager.getInfo(fresh.threadId)?.status === 'ready' &&
                entry !== undefined &&
                entryOutcome(entry).state === 'complete' &&
                relayStartedFrom(entry)
              );
            },
            WAIT,
          );
          expect(events.filter((event) => event.kind === 'browser_unavailable')).toEqual([]);
        } finally {
          await manager.destroy();
        }
      });
    }, 150_000);
  },
);
