import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigSchema } from '@inkeep/open-knowledge-server';
import { afterEach, expect, test, vi } from 'vitest';
import type { BundleIdentityState, BundleIdentityWatcherDeps } from './bundle-identity.ts';
import { startGlobalMcpServer } from './server.ts';

const observation = vi.hoisted(() => ({
  exact: 1152921500312607309n,
  numeric: 1152921500312607400,
  sampled: 0,
  detect: undefined as (() => BundleIdentityState) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    statSync: (...args: Parameters<typeof original.statSync>) => {
      const stats = original.statSync(...args);
      if (String(args[0]).replaceAll('\\', '/').endsWith('/mcp/server.ts')) {
        observation.sampled++;
        Object.defineProperty(stats, 'ino', {
          value: typeof stats.ino === 'bigint' ? observation.exact : observation.numeric,
        });
      }
      return stats;
    },
  };
});

vi.mock('./bundle-identity.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./bundle-identity.ts')>()),
  startBundleIdentityWatcher: (deps: BundleIdentityWatcherDeps) => {
    observation.detect = deps.detect;
    return { stop() {} };
  },
}));
vi.mock('./host-liveness.ts', () => ({ startHostLivenessWatch: () => ({ stop() {} }) }));
vi.mock('./lifecycle-logging.ts', () => ({ attachLifecycleLogging() {} }));
vi.mock('./stderr-mirror.ts', () => ({ createMcpStderrMirror: () => ({ write() {} }) }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {
    async start() {}
    async send() {}
    async close() {}
  },
}));

afterEach(() => vi.restoreAllMocks());

test.for([false, true])(
  'detects bundle replacement through MCP startup with inode collision=%s',
  async (collision) => {
    const scratch = resolve(import.meta.dirname, '../../../../tmp');
    mkdirSync(scratch, { recursive: true });
    const root = mkdtempSync(join(scratch, 'mcp-bundle-identity-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const signals = new Map(
      ['SIGINT', 'SIGTERM'].map((name) => [name, new Set(process.listeners(name))]),
    );
    const stdinEvents = new Map(
      ['end', 'error'].map((name) => [name, new Set(process.stdin.listeners(name))]),
    );
    observation.exact = collision ? 1152921500312607309n : 11n;
    observation.numeric = collision ? 1152921500312607400 : 11;
    observation.sampled = 0;
    observation.detect = undefined;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let handle: Awaited<ReturnType<typeof startGlobalMcpServer>> | undefined;
    try {
      handle = await startGlobalMcpServer({
        startupCwd: root,
        startupConfig: ConfigSchema.parse({}),
      });
      const detect = observation.detect;
      if (detect === undefined) throw new Error('Bundle watcher was not registered');
      expect(detect().kind).toBe('unchanged');
      observation.exact = collision ? 1152921500312607343n : 13n;
      observation.numeric = collision ? 1152921500312607400 : 13;
      expect(detect().kind).toBe('replaced');
      expect(observation.sampled).toBeGreaterThanOrEqual(3);
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
        ` inode=${collision ? 1152921500312607309n : 11n} `,
      );
    } finally {
      await handle?.close();
      for (const [name, prior] of signals) {
        for (const listener of process.listeners(name))
          if (!prior.has(listener)) process.removeListener(name, listener);
      }
      for (const [name, prior] of stdinEvents) {
        for (const listener of process.stdin.listeners(name))
          if (!prior.has(listener)) process.stdin.removeListener(name, listener);
      }
      if (platform) Object.defineProperty(process, 'platform', platform);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
