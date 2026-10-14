import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';

const active: BootedServer[] = [];
const roots: string[] = [];

async function boot(
  overrides: Parameters<typeof bootCompositionRig>[1] = {},
): Promise<BootedServer> {
  const root = mkdtempSync(resolve(tmpdir(), 'ok-applied-runtime-'));
  roots.push(root);
  const server = await bootCompositionRig(root, overrides);
  active.push(server);
  return server;
}

async function inspect(server: BootedServer) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/server-inspection`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    pid: number;
    projectRoot: string;
    serverInstanceId: string;
    runtime: {
      source: string;
      revision: number;
      effectiveSince: string;
      port: number;
      bind: string[];
      idleShutdown: string;
      externalUrl: string | null;
    } | null;
  }>;
}

afterEach(async () => {
  await Promise.allSettled(active.splice(0).map((server) => server.destroy()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('server applied runtime inspection', () => {
  test('reports bound listeners and identity with disabled idle shutdown', async () => {
    const server = await boot({ bind: ['127.0.0.1', '127.0.0.1', '::1'], port: 0 });
    const result = await inspect(server);
    expect(result).toEqual({
      pid: process.pid,
      projectRoot: realpathSync(server.contentDir),
      serverInstanceId: server.serverInstance.serverInstanceId,
      runtime: {
        source: 'server',
        revision: 1,
        effectiveSince: expect.any(String),
        port: server.port,
        bind: ['127.0.0.1', '::1'],
        idleShutdown: 'off',
        externalUrl: null,
      },
    });
    expect(server.port).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.runtime?.effectiveSince ?? ''))).toBe(false);
  });

  test('reports applied overrides rather than different config values', async () => {
    const config = ConfigSchema.parse({
      server: {
        port: 60001,
        bind: ['localhost'],
        idleShutdown: '2h',
        externalUrl: 'https://file.example',
      },
    });
    const server = await boot({
      config,
      serverRuntime: {
        ...resolveServerRuntimeConfig(config),
        externalUrl: 'https://env.example',
      },
      bind: ['127.0.0.1'],
      port: 0,
      idleShutdownMs: 90_000,
      idleShutdownValue: '90s',
    });
    const runtime = (await inspect(server)).runtime;
    expect(runtime).toMatchObject({
      port: server.port,
      bind: ['127.0.0.1'],
      idleShutdown: '90s',
      externalUrl: 'https://env.example',
    });
  });

  test('keeps the startup revision and timestamp across config edits and rejected content', async () => {
    const server = await boot({ idleShutdownMs: 60_000 });
    await server.ready;
    const before = await inspect(server);
    const configPath = resolve(server.contentDir, '.ok', 'config.yml');
    writeFileSync(
      configPath,
      'server:\n  idleShutdown: 5h\n  externalUrl: https://changed.example\n',
    );
    const localConfigPath = resolve(server.contentDir, '.ok', 'local', 'config.yml');
    writeFileSync(localConfigPath, 'linkPreviews:\n  enabled: true\n');
    await vi.waitFor(() => expect(server.serverInstance.getLinkPreviewsEnabled()).toBe(true));
    expect(await inspect(server)).toEqual(before);
    writeFileSync(localConfigPath, 'linkPreviews:\n  enabled: [invalid]\n');
    await new Promise((done) => setTimeout(done, 300));
    expect(await inspect(server)).toEqual(before);
  });

  test('returns a complete snapshot or null for direct callers', async () => {
    const server = await boot({ idleShutdownMs: 1250 });
    const result = await inspect(server);
    expect(result.runtime).toBeNull();
    expect(result.serverInstanceId).toBe(server.serverInstance.serverInstanceId);
  });

  test('rejects nonlocal Host and forwarding headers', async () => {
    const server = await boot();
    const badHost = await rawRequest(server.port, '/api/server-inspection', {
      headers: { Host: 'evil.example' },
    });
    expect(badHost.status).toBe(403);
    const forwarded = await rawRequest(server.port, '/api/server-inspection', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(forwarded.status).toBe(403);
  });
});
