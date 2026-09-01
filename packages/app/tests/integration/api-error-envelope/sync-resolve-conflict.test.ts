/**
 * Per-handler narrow-integration smoke test for `handleSyncResolveConflict`.
 *
 * The test harness has a SyncEngine but no real merge in progress, so
 * `engine.resolveConflict()` for a non-existent file throws → 500. Covers
 * happy-path body validation, body-shape errors, and method gating.
 */

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
    // Without the schema-level `.refine()`, this would reach the handler,
    // throw inside `engine.resolveConflict()` ("strategy 'content' requires
    // content parameter"), and emit `urn:ok:error:internal-server-error` 500.
    // The refinement promotes it to a typed 400 invalid-request at the
    // withValidation boundary — correct HTTP semantics for a client error.
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

  /**
   * Seed a tracked conflict so the marker check is reached against real store
   * state. `conflictStore` is private on the engine; this is the narrowest way
   * to put the handler in the state the 422's remediation text is written for,
   * short of driving a real merge.
   */
  function trackConflict(file: string): void {
    const engine = server.instance.syncEngine;
    if (!engine) throw new Error('expected a SyncEngine on the test harness');
    const store = (engine as unknown as { conflictStore: { addConflict: (e: unknown) => boolean } })
      .conflictStore;
    store.addConflict({ file, detectedAt: new Date().toISOString() });
  }

  test('content still carrying a conflict block is a typed 422, not a 500', async () => {
    // Asserted against a TRACKED conflict on purpose. The earlier version of
    // this test used an untracked path, which only reached the marker check
    // because that check had been hoisted above the tracked-conflict lookup —
    // so it pinned the mapping and the hoist together, and its 422 carried
    // remediation ("resolve every region") that was wrong for the state it
    // actually exercised. Tracked is the state the 422's advice is true for.
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
    // The sibling of the case above, and the reason neither mapping depends on
    // the order of the two guards any more. While `!entry` threw bare, this
    // returned 500 `internal-server-error`, which `resolve_conflict` documents
    // as a transient commit failure worth retrying — so an agent retried a path
    // that cannot succeed, and a caller-side error sat in the 5xx signal.
    //
    // Bad bytes are sent deliberately: both guards would fire, so this pins
    // which one answers, not merely that something 4xx happened.
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
