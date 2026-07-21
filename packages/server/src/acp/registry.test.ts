import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { AcpRegistry, loadCustomAgents, registryPlatformKey } from './registry.ts';

const log = getLogger('acp-registry-test');

const CATALOG = JSON.stringify({
  version: 1,
  agents: [
    {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '1.0.0',
      license: 'Apache-2.0',
      distribution: { npx: { package: '@google/gemini-cli@1.0.0', args: ['--acp'] } },
    },
    { id: 'broken' }, // missing required fields — dropped
  ],
});

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-registry-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('AcpRegistry', () => {
  test('parses the catalog, drops malformed entries, writes the disk cache', async () => {
    const localDir = tmp();
    const registry = new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => new Response(CATALOG, { status: 200 })) as typeof fetch,
    });
    const result = await registry.getCatalog();
    expect(result.stale).toBe(false);
    expect(result.agents.map((a) => a.id)).toEqual(['gemini']);
    const cached = await Bun.file(join(localDir, 'acp-registry-cache.json')).text();
    expect(cached).toBe(CATALOG);
  });

  test('serves the disk cache when the CDN is unreachable', async () => {
    const localDir = tmp();
    writeFileSync(join(localDir, 'acp-registry-cache.json'), CATALOG);
    const registry = new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    const result = await registry.getCatalog();
    expect(result.stale).toBe(true);
    expect(result.agents[0]?.id).toBe('gemini');
  });

  test('throws when offline with no cache', async () => {
    const registry = new AcpRegistry({
      localDir: tmp(),
      log,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    await expect(registry.getCatalog()).rejects.toThrow('offline');
  });
});

describe('loadCustomAgents', () => {
  test('returns valid entries, drops malformed ones, tolerates a missing file', async () => {
    const localDir = tmp();
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'my-agent', name: 'Mine', command: 'node', args: ['agent.js'] },
        { id: 'bad id!', name: 'Nope', command: 'x' }, // id fails AGENT_ID charset
        { id: 'no-command', name: 'Nope' },
      ]),
    );
    const agents = await loadCustomAgents(localDir, log);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe('my-agent');
  });
});

describe('registryPlatformKey', () => {
  test('returns a supported key on this host', () => {
    // The dev/CI fleet is darwin/linux on arm64/x64 — all enumerable.
    expect(registryPlatformKey()).toMatch(/^(darwin|linux|windows)-(aarch64|x86_64)$/);
  });
});
