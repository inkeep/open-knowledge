
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { sep } from 'node:path';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('GET /api/workspace', () => {
  test('returns canonical contentDir, platform path separator, and symlinkResolved:true', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/workspace`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      contentDir: string;
      pathSeparator: string;
      symlinkResolved: boolean;
      ok?: unknown;
    };
    expect(body.ok).toBeUndefined();
    expect(body.contentDir).toBe(server.contentDir);
    expect(body.pathSeparator).toBe(sep);
    expect(body.symlinkResolved).toBe(true);
  });

  test('rejects non-GET methods with 405 and RFC 9457 method-not-allowed problem', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('allow')).toBe('GET');
    const body = (await res.json()) as { type: string; title: string; status: number };
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
    expect(body.status).toBe(405);
  });

  test('rejects DNS-rebinding Host header with 403 even from loopback peer', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
      headers: { Host: 'attacker.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.status).toBe(403);
  });

  test('Host-header check fires before method dispatch (no verb fingerprinting)', async () => {
    const getRes = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
      headers: { Host: 'attacker.example.com' },
    });
    const postRes = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
      method: 'POST',
      headers: { Host: 'attacker.example.com' },
    });
    expect(getRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    const getBody = (await getRes.json()) as { type: string };
    const postBody = (await postRes.json()) as { type: string };
    expect(getBody.type).toBe('urn:ok:error:host-not-allowed');
    expect(postBody.type).toBe('urn:ok:error:host-not-allowed');
  });
});

describe('GET /api/workspace — filesystem edge cases', () => {
  let fsServer: TestServer;

  beforeAll(async () => {
    fsServer = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await fsServer.cleanup();
  });

  test('ENOENT on realpath returns 200 with symlinkResolved:false and unresolved path', async () => {
    rmSync(fsServer.contentDir, { recursive: true, force: true });
    const res = await fetch(`http://127.0.0.1:${fsServer.port}/api/workspace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contentDir: string;
      pathSeparator: string;
      symlinkResolved: boolean;
      ok?: unknown;
    };
    expect(body.ok).toBeUndefined();
    expect(body.symlinkResolved).toBe(false);
    expect(body.contentDir).toBe(fsServer.contentDir);
    expect(body.pathSeparator).toBe(sep);
  });
});
