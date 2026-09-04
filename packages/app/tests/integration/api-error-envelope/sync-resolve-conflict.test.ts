import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('sync-resolve-conflict envelope (RFC 9457)', () => {
  test('missing file body rejected with invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'mine' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('unknown strategy rejected with invalid-request', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'a.md', strategy: 'magic' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test("strategy 'content' without content body rejected with invalid-request (not 500)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'a.md', strategy: 'content' }),
    });
    expect(res.status).toBe(400);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  function trackConflict(file: string): void {
    const engine = server.instance.syncEngine;
    if (!engine) throw new Error('expected a SyncEngine on the test harness');
    const store = (engine as unknown as { conflictStore: { addConflict: (e: unknown) => boolean } })
      .conflictStore;
    store.addConflict({ file, detectedAt: new Date().toISOString() });
  }

  test('content still carrying a conflict block is a typed 422, not a 500', async () => {
    trackConflict('tracked-conflict.md');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: 'tracked-conflict.md',
        strategy: 'content',
        content: '<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n',
      }),
    });
    expect(res.status).toBe(422);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:unresolved-conflict-markers');
    }
  });

  test('an untracked path is a typed 404, not a 500 — even when the bytes are bad', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: 'never-tracked.md',
        strategy: 'content',
        content: '<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n',
      }),
    });
    expect(res.status).toBe(404);

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:no-conflict-tracked');
    }
  });

  test('method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');

    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });
});
