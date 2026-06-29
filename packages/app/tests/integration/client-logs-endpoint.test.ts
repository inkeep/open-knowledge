import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RENDERER_LOG_MAX_ENTRIES } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function postLogs(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/client-logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/client-logs', () => {
  test('accepts a valid batch and returns the written count', async () => {
    const res = await postLogs({
      entries: [
        { level: 'warn', message: 'plain warning' },
        {
          level: 'info',
          message:
            '{"event":"ok-provider-server-driven-close-reauth","reason":"Failed to connect"}',
          event: 'ok-provider-server-driven-close-reauth',
          fields: { reason: 'Failed to connect', docName: 'notes' },
          sourceId: 'app.js',
          lineNumber: 1515,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { accepted: number; ok?: unknown };
    expect(body.ok).toBeUndefined();
    expect(body.accepted).toBe(2);
  });

  test('accepts an empty batch (accepted: 0)', async () => {
    const res = await postLogs({ entries: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(0);
  });

  test('rejects an unknown level with 400', async () => {
    const res = await postLogs({ entries: [{ level: 'debug', message: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  test('rejects a batch over the entry cap with 400', async () => {
    const entries = Array.from({ length: RENDERER_LOG_MAX_ENTRIES + 1 }, () => ({
      level: 'info',
      message: 'x',
    }));
    const res = await postLogs({ entries });
    expect(res.status).toBe(400);
  });

  test('rejects non-POST methods with 405', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/client-logs`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  test('rejects a DNS-rebinding Host header with 403 even from a loopback peer', async () => {
    const res = await postLogs({ entries: [] }, { Host: 'attacker.example.com' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.status).toBe(403);
  });
});
