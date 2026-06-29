import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
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

async function postClone(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/local-op/clone`, {
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

describe('local-op-clone envelope (RFC 9457 + streaming, US-005, D36 c)', () => {
  test('pre-stream: malformed body emits problem+json 400 with urn:ok:error:invalid-request', async () => {
    const res = await postClone('not-valid-json{');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.status).toBe(400);
      expect(parsed.data.title.length).toBeGreaterThan(0);
      expect(parsed.data.instance).toBeDefined();
      if (parsed.data.instance) expect(parsed.data.instance).toMatch(UUID_RE);
      expect(parsed.data.status).toBe(res.status);
    }
  });

  test('pre-stream: missing url field emits problem+json 400 (LocalOpCloneRequestSchema validation)', async () => {
    const res = await postClone({ dir: '~/Documents/test' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.data.detail ?? '').toMatch(/url/i);
    }
  });

  test('pre-stream: blocked URL protocol emits urn:ok:error:url-not-allowed', async () => {
    const res = await postClone({ url: 'file:///etc/passwd', dir: '~/Documents/test' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:url-not-allowed');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('pre-stream: dir outside home emits urn:ok:error:dir-outside-home', async () => {
    const res = await postClone({ url: 'https://github.com/owner/repo', dir: '/etc/repo' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:dir-outside-home');
      expect(parsed.data.status).toBe(400);
    }
  });

  test('pre-stream: method not allowed on GET emits problem+json 405 with Allow: POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/clone`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.headers.get('allow')).toBe('POST');

    const body = await res.json();
    const parsed = ProblemDetailsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
      expect(parsed.data.status).toBe(405);
    }
  });

  test('mid-stream: spawn ENOENT emits typed { type: "error", problem: ProblemDetails } event on the NDJSON stream', async () => {
    const res = await postClone({
      url: 'https://github.com/owner/repo',
      dir: `${homedir()}/.ok-test-clone-target`,
    });
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
        expect(eventParsed.data.problem.type).toBe('urn:ok:error:clone-failed');
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
