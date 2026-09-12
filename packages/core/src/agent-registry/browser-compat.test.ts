/**
 * STOP: the agent-registry entrypoint must stay importable from the renderer.
 *
 * The registry is static capability data that the settings screen and the
 * launchers read directly. The moment anything under `agent-registry/` reaches
 * for the filesystem — or pulls in the server package to get at a predicate —
 * the renderer bundle breaks, and it breaks at runtime in a packaged build
 * rather than at build time here. Probing belongs to the hosts; they hand core
 * a snapshot.
 *
 * The guard is a runtime one rather than a source-text scan so it sees
 * TRANSITIVE imports too: every Node builtin and the server package are
 * poisoned to throw on load, then the entrypoint is imported for real. A
 * builtin reached from any depth blows up the import with the offending
 * specifier in the message.
 */

import { builtinModules } from 'node:module';
import { expect, it, vi } from 'vitest';

const POISONED_PACKAGES = ['@inkeep/open-knowledge-server'];

function poisonNodeAndServerModules(): void {
  for (const name of builtinModules) {
    const factory = () => {
      throw new Error(`agent-registry reached a Node builtin: ${name}`);
    };
    vi.doMock(name, factory);
    vi.doMock(`node:${name}`, factory);
  }
  for (const name of POISONED_PACKAGES) {
    vi.doMock(name, () => {
      throw new Error(`agent-registry reached a server-only package: ${name}`);
    });
  }
}

it('loads with no filesystem and no server package anywhere in its import graph', async () => {
  vi.resetModules();
  poisonNodeAndServerModules();

  const registry = await import('./index.ts');

  expect(registry.ALL_AGENT_IDS).toHaveLength(12);
  expect(Object.keys(registry.STATE_POLICY)).toHaveLength(registry.KNOWN_SURFACE_STATES.length);
  expect(registry.assessReadiness({ agentId: 'claude', mode: 'terminal' }).verdict).toBe('ready');

  vi.doUnmock('node:fs');
  vi.resetModules();
});

it('would notice a filesystem import, so the guard above is not vacuous', async () => {
  vi.resetModules();
  poisonNodeAndServerModules();

  await expect(import('node:fs')).rejects.toThrow();

  vi.resetModules();
});
