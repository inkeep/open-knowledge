import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
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
import { npmCli } from './package-acquisition.test-helper.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry, type RegistryAgent } from './registry.ts';
import { AcpThreadManager } from './thread-manager.ts';

const log = getLogger('npx-install-teardown-test');

const WAIT = { timeoutMs: 60_000 };
const TARBALL_ARRIVES_AFTER_MS = 10_000;
const REGISTRY_AGENT_ID = 'held-install';

const sessionManager = {
  getSession: async () => {
    throw new Error('the held agent never uses client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

function heldManager(held: HeldInstallRegistry): AcpThreadManager {
  const localDir = mkdtempSync(join(held.home, 'local-'));
  const contentDir = mkdtempSync(join(held.home, 'content-'));
  const agent: RegistryAgent = {
    id: REGISTRY_AGENT_ID,
    name: 'Held install agent',
    version: '1.0.0',
    distribution: { npx: { package: held.npmPackage } },
  };
  return new AcpThreadManager({
    contentDir,
    localDir,
    globalDir: null,
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
  });
}

type InstallingThread = { threadId: string; dependencyRequests: number };

const SITES = [
  {
    site: 'a registry agent whose npx lacks npm',
    open: async (
      manager: AcpThreadManager,
      held: HeldInstallRegistry,
    ): Promise<InstallingThread> => {
      const npxOnly = join(held.home, 'npx-only-bin');
      mkdirSync(npxOnly);
      symlinkSync(npmCli('npx'), join(npxOnly, 'npx'));
      process.env.PATH = `${npxOnly}${delimiter}${process.env.PATH ?? ''}`;
      const info = await manager.createThread({
        agent: { source: 'registry', id: REGISTRY_AGENT_ID },
      });
      return { threadId: info.threadId, dependencyRequests: 1 };
    },
  },
  {
    site: 'a reopened agent whose cache was wiped',
    open: async (
      manager: AcpThreadManager,
      held: HeldInstallRegistry,
    ): Promise<InstallingThread> => {
      const first = await manager.createThread({
        agent: { source: 'registry', id: REGISTRY_AGENT_ID },
      });
      held.release('npm-dependency');
      await waitWithinTestBudget(
        'the first thread to install the agent and start it',
        () => {
          const status = manager.getInfo(first.threadId)?.status;
          if (status === 'error' || status === 'exited') {
            throw new Error(`the first thread settled as ${status}`);
          }
          return status === 'ready';
        },
        WAIT,
      );
      await manager.closeThread(first.threadId);
      const [installed] = npxEntries(held.home);
      expect(installed, 'the first thread left an installed npx cache entry').toBeDefined();
      expect(hasManifest(String(installed))).toBe(true);
      rmSync(join(held.home, 'npm-cache', '_npx'), { recursive: true, force: true });
      rmSync(join(held.home, 'npm-cache', '_cacache'), { recursive: true, force: true });
      held.rearm('npm-dependency');
      const second = await manager.createThread({
        agent: { source: 'registry', id: REGISTRY_AGENT_ID },
      });
      return { threadId: second.threadId, dependencyRequests: 2 };
    },
  },
] as const;

const TEARDOWNS = [
  {
    teardown: 'the thread is closed',
    run: (manager: AcpThreadManager, threadId: string) => manager.closeThread(threadId),
  },
  {
    teardown: 'the server shuts its threads down',
    run: (manager: AcpThreadManager) => manager.destroy(),
  },
] as const;

const CASES = SITES.flatMap((site) => TEARDOWNS.map((teardown) => ({ ...site, ...teardown })));

describe.skipIf(process.platform === 'win32')(
  'tearing down a thread whose agent child is still installing its npx package',
  () => {
    test.each(CASES)(
      'the npx cache entry ends complete or rolled back when $teardown while $site is installing',
      async ({ open, run }) => {
        expect(
          () => descendantsOf(process.pid),
          'this test reads the process table with ps',
        ).not.toThrow();
        await withHeldInstallRegistry(async (held) => {
          const agentName = held.npmPackage.slice(0, held.npmPackage.lastIndexOf('@'));
          const preexisting = new Set(descendantsOf(process.pid));
          const started = new Set<number>();
          const liveSinceStart = (): number[] => {
            const live = descendantsOf(process.pid).filter((pid) => !preexisting.has(pid));
            for (const pid of live) started.add(pid);
            return live;
          };
          const everyStartedProcessEnded = (): boolean =>
            liveSinceStart().length === 0 && [...started].every(processEnded);
          const manager = heldManager(held);
          const path = process.env.PATH;
          try {
            const { threadId, dependencyRequests } = await open(manager, held);
            await waitWithinTestBudget(
              'npm to request the held dependency tarball mid-install',
              () => {
                liveSinceStart();
                const status = manager.getInfo(threadId)?.status;
                if (status === 'error' || status === 'exited') {
                  throw new Error(`the thread settled as ${status} before npm reached the tarball`);
                }
                return held.requested('npm-dependency') === dependencyRequests;
              },
              WAIT,
            );
            const entries = npxEntries(held.home);
            expect(entries).toHaveLength(1);
            const entry = String(entries[0]);
            expect(hasManifest(entry), 'npm is still installing when the teardown begins').toBe(
              false,
            );

            let teardownSettled = false;
            const teardownStartedAt = Date.now();
            const teardown = run(manager, threadId);
            teardown.then(
              () => {
                teardownSettled = true;
              },
              () => {
                teardownSettled = true;
              },
            );
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
            held.release('npm-dependency');
            await teardown;
            await waitWithinTestBudget(
              'every process the thread started to exit',
              everyStartedProcessEnded,
              WAIT,
            );

            const outcome = entryOutcome(entry, agentName);
            expect(['complete', 'rolled-back'], JSON.stringify(outcome)).toContain(outcome.state);
          } finally {
            process.env.PATH = path;
            held.release('npm-dependency');
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
  },
);
