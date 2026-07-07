/**
 * Per-handler narrow-integration smoke test for `handleLocalOpAuthRepos`
 *
 * Pre-stream errors emit `application/problem+json`; mid-stream errors emit
 * a typed `{ type: 'error', problem: ProblemDetails }` event. ENOENT on the
 * spawn deterministically triggers the mid-stream path.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProblemDetailsSchema, StreamingProblemEventSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({
    localOpCliArgs: ['/nonexistent-test-binary-do-not-create-this-file'],
  });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const UUID_RE = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postRepos(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/repos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readNdjsonEvents(res: Response): Promise<unknown[]> {
  const reader = res.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ __raw: line });
      }
    }
  }
  if (buffer.trim()) {
    try {
      events.push(JSON.parse(buffer));
    } catch {
      events.push({ __raw: buffer });
    }
  }
  return events;
}

describe('local-op-auth-repos envelope (RFC 9457 + streaming, US-012)', () => {
  test('pre-stream: malformed JSON body emits problem+json 400', async () => {
    const res = await postRepos('not-valid-json{');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
    }
  });

  test('pre-stream: empty host string emits problem+json 400', async () => {
    const res = await postRepos({ host: '' });
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
    }
  });

  test('pre-stream: method-not-allowed on GET emits problem+json with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/repos`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
    }
  });

  test('mid-stream: spawn ENOENT emits typed { type: "error", problem } event on the NDJSON stream', async () => {
    const res = await postRepos({});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');

    const events = await readNdjsonEvents(res);
    expect(events.length).toBeGreaterThan(0);

    const errorEvents = events.filter(
      (e): e is { type: string; problem: unknown } =>
        typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'error',
    );
    expect(errorEvents.length).toBeGreaterThan(0);

    for (const evt of errorEvents) {
      const eventParsed = StreamingProblemEventSchema.safeParse(evt);
      expect(eventParsed.success).toBe(true);
      if (eventParsed.success) {
        expect(eventParsed.data.type).toBe('error');
        expect(eventParsed.data.problem.type).toBe('urn:ok:error:auth-failed');
        expect(eventParsed.data.problem.status).toBe(500);
        expect(eventParsed.data.problem.title.length).toBeGreaterThan(0);
        expect(eventParsed.data.problem.instance).toBeDefined();
        if (eventParsed.data.problem.instance) {
          expect(eventParsed.data.problem.instance).toMatch(UUID_RE);
        }
      }

      const problemParsed = ProblemDetailsSchema.safeParse((evt as { problem: unknown }).problem);
      expect(problemParsed.success).toBe(true);
    }
  });
});
