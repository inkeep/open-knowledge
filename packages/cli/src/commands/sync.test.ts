import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@inkeep/open-knowledge-server';
import { RUNTIME_VERSION } from '@inkeep/open-knowledge-server';
import { runSync } from './sync.ts';


function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name)?.[1];
  if (h) return (h as Record<string, string>)[name];
  return undefined;
}

describe('runSync — client version headers (AC-5)', () => {
  const origFetch = globalThis.fetch;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-sync-test-'));
    const lockDir = join(dir, '.ok', 'local');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'server.lock'),
      JSON.stringify({ pid: process.pid, hostname: hostname(), port: 54321 }),
    );
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test('POST /api/sync/trigger carries kind=cli version headers', async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await runSync({ json: true, op: 'sync' }, {} as Config, dir);

    expect(headerOf(seen, 'x-ok-client-protocol')).toBe('1');
    expect(headerOf(seen, 'x-ok-client-kind')).toBe('cli');
    expect(headerOf(seen, 'x-ok-client-runtime')).toBe(RUNTIME_VERSION);
    expect(headerOf(seen, 'Content-Type')).toBe('application/json');
  });
});
