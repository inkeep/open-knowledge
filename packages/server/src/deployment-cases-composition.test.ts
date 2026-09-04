import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveEnvConfigLayer, resolveServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';

let tmpRoot: string;
let case2: BootedServer;
let case3: BootedServer;

const CASE2_ENV = {
  OK_BIND: '127.0.0.1 100.64.0.7',
  OK_ALLOW_EXTERNAL: '1',
  OK_EXTERNAL_URL: 'http://laptop.tail:55222',
};

const CASE3_ENV = {
  PORT: '8080',
  OK_EXTERNAL_URL: 'https://notes.example.com',
  OK_ALLOW_EXTERNAL: '1',
};

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-deploy-cases-'));

  const case2Config = ConfigSchema.parse({ server: resolveEnvConfigLayer(CASE2_ENV).layer.server });
  case2 = await bootCompositionRig(mkdtempSync(resolve(tmpRoot, 'case2-')), {
    config: case2Config,
    serverRuntime: resolveServerRuntimeConfig(case2Config),
    bind: ['127.0.0.1'],
  });
  await case2.ready;

  const case3Config = ConfigSchema.parse({
    server: {
      ...(resolveEnvConfigLayer(CASE3_ENV).layer.server as Record<string, unknown>),
      port: undefined,
    },
  });
  case3 = await bootCompositionRig(mkdtempSync(resolve(tmpRoot, 'case3-')), {
    config: case3Config,
    serverRuntime: resolveServerRuntimeConfig(case3Config),
  });
  await case3.ready;
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([case2?.destroy(), case3?.destroy()]);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('deck env spellings resolve to the booted config', () => {
  test('Case 2: OK_BIND (space-separated) + OK_ALLOW_EXTERNAL=1 + OK_EXTERNAL_URL', () => {
    expect(resolveEnvConfigLayer(CASE2_ENV).layer).toEqual({
      server: {
        bind: ['127.0.0.1', '100.64.0.7'],
        allowExternal: true,
        externalUrl: 'http://laptop.tail:55222',
      },
    });
  });

  test('Case 3: platform PORT + OK_EXTERNAL_URL + OK_ALLOW_EXTERNAL=1', () => {
    expect(resolveEnvConfigLayer(CASE3_ENV).layer).toEqual({
      server: {
        port: 8080,
        externalUrl: 'https://notes.example.com',
        allowExternal: true,
      },
    });
  });
});

describe('Case 2 — tailnet bind + consent + externalUrl', () => {
  test("a teammate's browser read under the externalUrl Host answers", async () => {
    const res = await rawRequest(case2.port, '/api/server-info', {
      headers: { Host: 'laptop.tail:55222' },
    });
    expect(res.status).toBe(200);
  });

  test("a teammate's mutating write is admitted (Host + Origin from externalUrl)", async () => {
    const res = await rawRequest(case2.port, '/api/create-page', {
      method: 'POST',
      headers: {
        Host: 'laptop.tail:55222',
        Origin: 'http://laptop.tail:55222',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 'case2-teammate.md' }),
    });
    expect(res.status).toBe(200);
  });

  test('the bind-address literal works as a Host with zero extra config', async () => {
    const read = await rawRequest(case2.port, '/api/server-info', {
      headers: { Host: `100.64.0.7:${case2.port}` },
    });
    expect(read.status).toBe(200);
    const write = await rawRequest(case2.port, '/api/create-page', {
      method: 'POST',
      headers: {
        Host: `100.64.0.7:${case2.port}`,
        Origin: `http://100.64.0.7:${case2.port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 'case2-bind-literal.md' }),
    });
    expect(write.status).toBe(200);
  });

  test('an MCP client (no Origin header) is admitted under the externalUrl Host', async () => {
    const res = await rawRequest(case2.port, '/api/create-page', {
      method: 'POST',
      headers: { Host: 'laptop.tail:55222', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'case2-mcp.md' }),
    });
    expect(res.status).toBe(200);
  });

  test('unconfigured names stay refused — consent never widens the name gates', async () => {
    const write = await rawRequest(case2.port, '/api/create-page', {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'never.md' }),
    });
    expect(write.status).toBe(403);
    expect(parseProblem(write.body).type).toBe('urn:ok:error:host-not-allowed');
    const origin = await rawRequest(case2.port, '/api/server-info', {
      headers: { Host: 'laptop.tail:55222', Origin: 'https://evil.example' },
    });
    expect(origin.status).toBe(403);
    expect(parseProblem(origin.body).type).toBe('urn:ok:error:invalid-origin');
  });

  test('local loopback access keeps working alongside the exposure', async () => {
    const res = await rawRequest(case2.port, '/api/server-info', {
      headers: { Host: `127.0.0.1:${case2.port}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('Case 3 — loopback bind behind a reverse proxy + externalUrl + consent', () => {
  const proxied = (extra: Record<string, string> = {}) => ({
    Host: 'notes.example.com',
    'X-Forwarded-For': '203.0.113.7',
    'X-Forwarded-Proto': 'https',
    ...extra,
  });

  test('proxied reads answer — forwarded headers are tolerated, not refused', async () => {
    const res = await rawRequest(case3.port, '/api/server-info', { headers: proxied() });
    expect(res.status).toBe(200);
  });

  test('proxied mutating writes are admitted with the public Origin', async () => {
    const res = await rawRequest(case3.port, '/api/create-page', {
      method: 'POST',
      headers: proxied({
        Origin: 'https://notes.example.com',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({ path: 'case3-proxied.md' }),
    });
    expect(res.status).toBe(200);
  });

  test('a wrong Host through the proxy is refused (rebinding shape)', async () => {
    const res = await rawRequest(case3.port, '/api/create-page', {
      method: 'POST',
      headers: {
        Host: 'evil.example',
        'X-Forwarded-For': '203.0.113.7',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 'never.md' }),
    });
    expect(res.status).toBe(403);
  });

  test('the wrong scheme on the public Origin is refused (scheme-matched)', async () => {
    const res = await rawRequest(case3.port, '/api/server-info', {
      headers: proxied({ Origin: 'http://notes.example.com' }),
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:invalid-origin');
  });

  test('same-box loopback consumers keep working (the lock contract)', async () => {
    const res = await rawRequest(case3.port, '/api/server-info', {
      headers: { Host: `127.0.0.1:${case3.port}` },
    });
    expect(res.status).toBe(200);
  });
});
