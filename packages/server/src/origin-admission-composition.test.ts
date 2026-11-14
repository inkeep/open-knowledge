import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, onTestFinished, test } from 'vitest';
import { WebSocket } from 'ws';
import { isAllowedApiOrigin } from './api-origin.ts';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeSyntheticReq,
  parseProblem,
  rawRequest,
} from './composition-rig.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';
import { buildIngressPolicy, isOriginAdmitted } from './ingress-policy.ts';
import { hasValidLocalOpOrigin } from './local-op-security.ts';

const OTHER_LOOPBACK_ORIGINS = ['ftp://localhost', 'custom://127.0.0.1', 'custom://[::1]'];
const COLLAB_PATHS = ['/collab', '/collab/keepalive', '/collab/thread'];
const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'origin-admission-composition', version: '0.0.0' },
  },
});

interface HttpCase {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  admittedStatus: number;
}

const HTTP_CASES: HttpCase[] = [
  { method: 'GET', path: '/api/config', headers: {}, admittedStatus: 200 },
  {
    method: 'GET',
    path: '/api/document?docName=alpha',
    headers: {},
    admittedStatus: 200,
  },
  {
    method: 'POST',
    path: '/api/create-page',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'origin-admitted.md' }),
    admittedStatus: 200,
  },
  { method: 'POST', path: '/api/git/worktree-status', headers: {}, admittedStatus: 405 },
  { method: 'GET', path: '/api/local-op/auth/status', headers: {}, admittedStatus: 405 },
  {
    method: 'POST',
    path: '/api/skill-upload?scope=global',
    headers: { 'Content-Type': 'multipart/form-data; boundary=origin-test-boundary' },
    body: '--origin-test-boundary--\r\n',
    admittedStatus: 400,
  },
  { method: 'OPTIONS', path: '/mcp', headers: {}, admittedStatus: 204 },
  {
    method: 'POST',
    path: '/mcp',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: MCP_INITIALIZE,
    admittedStatus: 200,
  },
];

let root: string;
let server: BootedServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-origin-admission-'));
  const contentDir = mkdtempSync(join(root, 'content-'));
  writeFileSync(join(contentDir, 'alpha.md'), '# Alpha\n\nOrigin admission fixture.\n');
  const config = ConfigSchema.parse({
    server: {
      bind: ['127.0.0.1', '100.64.0.7'],
      externalUrl: 'https://notes.example.com',
      allowExternal: true,
    },
  });
  server = await bootCompositionRig(contentDir, {
    config,
    serverRuntime: resolveServerRuntimeConfig(config),
    bind: ['127.0.0.1'],
  });
  await server.ready;
});

afterAll(async () => {
  await server?.destroy();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

async function upgradeOutcome(path: string, origin?: string): Promise<'open' | 'refused'> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}${path}`,
    origin === undefined ? {} : { origin },
  );
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  onTestFinished(async () => {
    socket.terminate();
    await closed;
  });
  const outcome = await new Promise<'open' | 'refused'>((resolve, reject) => {
    socket.once('open', () => resolve('open'));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      if (response.statusCode === 403) resolve('refused');
      else reject(new Error(`Unexpected upgrade response: ${response.statusCode}`));
    });
    socket.on('error', (error) => {
      if ('code' in error && error.code === 'ECONNRESET') resolve('refused');
      else reject(error);
    });
    socket.once('close', () => reject(new Error('Connection closed before its upgrade outcome')));
  });
  socket.terminate();
  await closed;
  return outcome;
}

describe('loopback origin predicates', () => {
  test.each(OTHER_LOOPBACK_ORIGINS)('API origins require http or https: %s', (origin) => {
    expect(isAllowedApiOrigin(origin)).toBe(false);
  });

  test.each(OTHER_LOOPBACK_ORIGINS)(
    'local-operation origins require http or https: %s',
    (origin) => {
      expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin }))).toBe(false);
    },
  );

  test.each(['http://notes.example.com', 'https://notes.example.com'])(
    'the configured external scheme remains admitted: %s',
    (origin) => {
      const config = ConfigSchema.parse({ server: { externalUrl: origin, allowExternal: true } });
      const policy = buildIngressPolicy({ serverRuntime: resolveServerRuntimeConfig(config) });
      expect(isOriginAdmitted(origin, policy)).toBe(true);
      expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin }), policy)).toBe(true);
    },
  );

  test('local operations keep their no-Origin and file-origin rules', () => {
    expect(hasValidLocalOpOrigin(makeSyntheticReq({}))).toBe(true);
    expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin: 'file://' }))).toBe(false);
  });
});

describe('origin admission on the real server', () => {
  test('clients without Origin keep API writes and MCP initialization', async () => {
    const write = await rawRequest(server.port, '/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'origin-client-create.md' }),
    });
    expect(write.status).toBe(200);
    const initialize = await rawRequest(server.port, '/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: MCP_INITIALIZE,
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers['mcp-session-id']).toBeTruthy();
  });

  test.each(HTTP_CASES)(
    '$method $path requires http or https for a loopback page',
    async (entry) => {
      const control = await rawRequest(server.port, entry.path, entry);
      expect(control.status).toBe(entry.admittedStatus);
      const refused = await rawRequest(server.port, entry.path, {
        ...entry,
        headers: { ...entry.headers, Origin: 'ftp://localhost' },
      });
      expect(refused.status).toBe(403);
      expect(parseProblem(refused.body).type).toBe('urn:ok:error:invalid-origin');
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  test.each(COLLAB_PATHS)('%s requires http or https for a loopback page', async (path) => {
    await expect(upgradeOutcome(path)).resolves.toBe('open');
    await expect(upgradeOutcome(path, 'ftp://localhost')).resolves.toBe('refused');
  });

  test.each([
    'http://localhost:5173',
    'https://127.0.0.1:8443',
    'https://notes.example.com',
    'http://100.64.0.7:55222',
    'https://100.64.0.7:55222',
  ])('kept page origin can read the API: %s', async (origin) => {
    const response = await rawRequest(server.port, '/api/config', { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
  });

  test('file pages keep reads without a CORS grant and refused writes', async () => {
    const read = await rawRequest(server.port, '/api/document?docName=alpha', {
      headers: { Origin: 'file://' },
    });
    expect(read.status).toBe(200);
    expect(read.body).toContain('Origin admission fixture.');
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
    const write = await rawRequest(server.port, '/api/create-page', {
      method: 'POST',
      headers: { Origin: 'file://', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'file-origin-write.md' }),
    });
    expect(write.status).toBe(403);
    expect(parseProblem(write.body).type).toBe('urn:ok:error:invalid-origin');
  });

  test.each(COLLAB_PATHS)('%s keeps file and configured page origins', async (path) => {
    for (const origin of ['file://', 'http://localhost:5173', 'https://notes.example.com']) {
      await expect(upgradeOutcome(path, origin)).resolves.toBe('open');
    }
  });
});

describe('preserved file page origins', () => {
  test.each(['file://127.0.0.1', 'file://[::1]'])(
    'API origins keep loopback file pages: %s',
    (origin) => {
      expect(isAllowedApiOrigin(origin)).toBe(true);
    },
  );

  test.each(['file://127.0.0.1', 'file://[::1]'])(
    'local-operation origins keep loopback file pages: %s',
    (origin) => {
      expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin }))).toBe(true);
    },
  );

  test('configured bind literals keep web origins without admitting file origins', () => {
    const config = ConfigSchema.parse({ server: { bind: ['100.64.0.7'] } });
    const policy = buildIngressPolicy({ serverRuntime: resolveServerRuntimeConfig(config) });
    expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin: 'http://100.64.0.7' }), policy)).toBe(
      true,
    );
    expect(hasValidLocalOpOrigin(makeSyntheticReq({ origin: 'file://100.64.0.7' }), policy)).toBe(
      false,
    );
  });
});
