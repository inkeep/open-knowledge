import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  parseProblem,
  type RawResponse,
  rawRequest,
} from './composition-rig.test-helper.ts';
import { OPAQUE_ORIGIN_REFUSAL_DETAIL } from './ingress-policy.ts';

const LOOPBACK_ORIGIN = 'http://localhost:5173';
const MCP_INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'opaque-origin-composition', version: '0.0.0' },
  },
});

let tmpRoot: string;
let contentDir: string;
let server: BootedServer;

function contentFiles(): string[] {
  return readdirSync(contentDir, { recursive: true, encoding: 'utf-8' })
    .filter((entry) => !entry.startsWith('.ok') && !entry.startsWith('.git'))
    .sort();
}

function expectNoCorsGrant(res: RawResponse | Response): void {
  const header = (name: string) =>
    res instanceof Response ? res.headers.get(name) : (res.headers[name] ?? null);
  expect(header('access-control-allow-origin')).toBeNull();
  expect(header('access-control-allow-methods')).toBeNull();
  expect(header('access-control-allow-headers')).toBeNull();
}

function uploadForm(name: string): FormData {
  const form = new FormData();
  form.append('parentDocName', 'alpha');
  form.append('file', new Blob([`png-ish bytes for ${name}`]), name);
  return form;
}

function upgradeOutcome(path: string, origin: string | undefined): Promise<'open' | 'refused'> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WsClient(
      `ws://127.0.0.1:${server.port}${path}`,
      origin === undefined ? {} : { origin },
    );
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for the ${path} upgrade outcome`));
    }, 5_000);
    const settle = (outcome: 'open' | 'refused') => {
      clearTimeout(timer);
      ws.terminate();
      resolvePromise(outcome);
    };
    ws.once('open', () => settle('open'));
    ws.once('unexpected-response', () => settle('refused'));
    ws.once('error', () => settle('refused'));
  });
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-opaque-origin-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nPrivate body.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('reads from an opaque origin on the real server', () => {
  test('GET /api/document from null is refused; from file:// it carries no grant; loopback keeps its grant', async () => {
    const fromNull = await rawRequest(server.port, '/api/document?docName=alpha', {
      headers: { Origin: 'null' },
    });
    expect(fromNull.status).toBe(403);
    expect(parseProblem(fromNull.body)).toMatchObject({
      type: 'urn:ok:error:invalid-origin',
      detail: OPAQUE_ORIGIN_REFUSAL_DETAIL,
    });
    expect(fromNull.body).not.toContain('Private body.');
    expectNoCorsGrant(fromNull);

    const fromFile = await rawRequest(server.port, '/api/document?docName=alpha', {
      headers: { Origin: 'file://' },
    });
    expect(fromFile.status).toBe(200);
    expectNoCorsGrant(fromFile);

    const loopback = await rawRequest(server.port, '/api/document?docName=alpha', {
      headers: { Origin: LOOPBACK_ORIGIN },
    });
    expect(loopback.status).toBe(200);
    expect(loopback.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
    expect((JSON.parse(loopback.body) as { content?: string }).content).toContain('Private body.');
  });

  test('the preflight an opaque origin would need is not granted; the loopback preflight is', async () => {
    for (const path of ['/api/document?docName=alpha', '/api/create-page', '/api/upload']) {
      for (const [origin, status] of [
        ['null', 403],
        ['file://', 204],
      ] as const) {
        const res = await rawRequest(server.port, path, {
          method: 'OPTIONS',
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
        });
        expect(res.status, `${origin} ${path}`).toBe(status);
        expectNoCorsGrant(res);
      }
      const loopback = await rawRequest(server.port, path, {
        method: 'OPTIONS',
        headers: { Origin: LOOPBACK_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      });
      expect(loopback.status, path).toBe(204);
      expect(loopback.headers['access-control-allow-origin'], path).toBe(LOOPBACK_ORIGIN);
    }
  });

  test('a GET carrying a stray content-type still reads the document', async () => {
    const res = await rawRequest(server.port, '/api/document?docName=alpha', {
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { content?: string }).content).toContain('Private body.');
  });
});

describe('writes on the real server take JSON from a site origin only', () => {
  test('POST /api/create-page with a text/plain JSON body answers 415 and creates nothing', async () => {
    const before = contentFiles();
    for (const headers of [
      { 'Content-Type': 'text/plain' },
      { 'Content-Type': 'text/plain', Origin: LOOPBACK_ORIGIN },
    ]) {
      const res = await rawRequest(server.port, '/api/create-page', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'simple-request.md' }),
      });
      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toBe('application/problem+json');
      const problem = parseProblem(res.body);
      expect(problem.type).toBe('urn:ok:error:unsupported-media-type');
      expect(problem.detail).toContain('Content-Type: application/json');
    }
    expect(existsSync(resolve(contentDir, 'simple-request.md'))).toBe(false);
    expect(contentFiles()).toEqual(before);
  });

  test('every JSON write route refuses a text/plain body with 415, direct body readers included', async () => {
    for (const path of [
      '/api/create-page',
      '/api/agent-write',
      '/api/skill/install',
      '/api/comment',
      '/api/comments',
      '/api/handoff',
      '/api/spawn-cursor',
      '/api/link-preview',
    ]) {
      const res = await rawRequest(server.port, path, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          ...(path === '/api/link-preview' ? { Origin: LOOPBACK_ORIGIN } : {}),
        },
        body: 'not json',
      });
      expect(res.status, `${path}: ${res.body}`).toBe(415);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:unsupported-media-type');
    }
  });

  test('a multipart upload from a site origin lands in the content root, a JSON body there is malformed-upload', async () => {
    const before = contentFiles();
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      headers: { Origin: LOOPBACK_ORIGIN },
      body: uploadForm('site-upload.png'),
    });
    expect(ok.status).toBe(200);
    const afterUpload = contentFiles();
    expect(afterUpload).toEqual([...before, 'site-upload.png'].sort());

    const json = await rawRequest(server.port, '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentDocName: 'alpha' }),
    });
    expect(json.status).toBe(400);
    expect(parseProblem(json.body).type).toBe('urn:ok:error:malformed-upload');
    expect(contentFiles()).toEqual(afterUpload);
  });

  test('every write from an opaque origin is refused 403 and creates nothing', async () => {
    const before = contentFiles();
    for (const origin of ['null', 'file://']) {
      for (const contentType of ['text/plain', 'application/json']) {
        const res = await rawRequest(server.port, '/api/create-page', {
          method: 'POST',
          headers: { 'Content-Type': contentType, Origin: origin },
          body: JSON.stringify({ path: 'opaque-write.md' }),
        });
        expect(res.status, `${origin} ${contentType}`).toBe(403);
        expect(parseProblem(res.body)).toMatchObject({
          type: 'urn:ok:error:invalid-origin',
          detail: OPAQUE_ORIGIN_REFUSAL_DETAIL,
        });
        expectNoCorsGrant(res);
      }
      const upload = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
        method: 'POST',
        headers: { Origin: origin },
        body: uploadForm('opaque-upload.png'),
      });
      expect(upload.status, origin).toBe(403);
      expect(((await upload.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
      expectNoCorsGrant(upload);
    }
    expect(existsSync(resolve(contentDir, 'opaque-write.md'))).toBe(false);
    expect(contentFiles()).toEqual(before);
  });

  test('application/json create-page still works bare and same-origin with the app headers', async () => {
    const bare = await rawRequest(server.port, '/api/create-page', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'seeded-bare.md' }),
    });
    expect(bare.status).toBe(200);
    expect(existsSync(resolve(contentDir, 'seeded-bare.md'))).toBe(true);

    const sameOrigin = `http://127.0.0.1:${server.port}`;
    const app = await fetch(`${sameOrigin}/api/create-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: sameOrigin,
        'x-ok-client-protocol': '1',
        'x-ok-client-runtime': '0.0.0-test',
        'x-ok-client-kind': 'web',
      },
      body: JSON.stringify({ path: 'seeded-app.md' }),
    });
    expect(app.status).toBe(200);
    expect(app.headers.get('access-control-allow-origin')).toBe(sameOrigin);
    expect(existsSync(resolve(contentDir, 'seeded-app.md'))).toBe(true);
  });
});

describe('/mcp on the real server', () => {
  test('MCP from an opaque origin is refused and its preflight is not granted', async () => {
    for (const origin of ['null', 'file://']) {
      const init = await rawRequest(server.port, '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Origin: origin,
        },
        body: MCP_INITIALIZE,
      });
      expect(init.status, origin).toBe(403);
      expect(parseProblem(init.body)).toMatchObject({
        type: 'urn:ok:error:invalid-origin',
        detail: OPAQUE_ORIGIN_REFUSAL_DETAIL,
      });
      expectNoCorsGrant(init);

      const preflight = await rawRequest(server.port, '/mcp', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      expect(preflight.status, origin).toBe(origin === 'null' ? 403 : 204);
      expectNoCorsGrant(preflight);
    }
    const loopback = await rawRequest(server.port, '/mcp', {
      method: 'OPTIONS',
      headers: { Origin: LOOPBACK_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(loopback.status).toBe(204);
    expect(loopback.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
  });

  test('an MCP client without an Origin still initializes', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: MCP_INITIALIZE,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });
});

describe('collaboration WebSocket upgrades on the real server', () => {
  test('/collab refuses a null origin and still opens for the desktop file:// origin and loopback', async () => {
    await expect(upgradeOutcome('/collab', 'null')).resolves.toBe('refused');
    await expect(upgradeOutcome('/collab', 'file://')).resolves.toBe('open');
    await expect(upgradeOutcome('/collab', LOOPBACK_ORIGIN)).resolves.toBe('open');
  });

  test('/collab/thread refuses a null origin and still opens for file:// and loopback', async () => {
    await expect(upgradeOutcome('/collab/thread', 'null')).resolves.toBe('refused');
    await expect(upgradeOutcome('/collab/thread', 'file://')).resolves.toBe('open');
    await expect(upgradeOutcome('/collab/thread', LOOPBACK_ORIGIN)).resolves.toBe('open');
  });

  test('/collab/keepalive refuses a null origin and still opens without one', async () => {
    await expect(upgradeOutcome('/collab/keepalive', 'null')).resolves.toBe('refused');
    await expect(upgradeOutcome('/collab/keepalive', undefined)).resolves.toBe('open');
  });
});
