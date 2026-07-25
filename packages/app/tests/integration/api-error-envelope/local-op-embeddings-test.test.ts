/**
 * Per-handler narrow-integration test for `handleLocalOpEmbeddingsTest`
 * (`POST /api/local-op/embeddings/test`).
 *
 * The probe is the only thing standing between "my custom endpoint works" and
 * "semantic search silently fell back to keyword matching", so this drives it
 * against a real loopback embeddings server rather than a stubbed fetch: the
 * request really leaves the process, the response is really parsed, and the
 * detected vector size is really read off the wire.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalOpEmbeddingsTestResponseSchema,
  ProblemDetailsSchema,
} from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type FakeEmbeddingsServer,
  startFakeEmbeddingsServer,
} from '../../../../server/src/embeddings/fake-provider.test-helper.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from '../harness-boot-timeout';
import { createTestServer, type TestServer } from '../test-harness';

let server: TestServer;
let provider: FakeEmbeddingsServer;
let contentDir: string;
let homeDir: string;

const MODEL = 'nomic-embed-text';
const PROVIDER_DIMS = 1024;

beforeAll(async () => {
  provider = await startFakeEmbeddingsServer({ dims: PROVIDER_DIMS });
  contentDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-content-'));
  homeDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-home-'));

  mkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), '', 'utf-8');
  writeFileSync(
    join(contentDir, '.ok', 'local', 'config.yml'),
    `search:\n  semantic:\n    enabled: true\n    baseUrl: ${provider.baseUrl}\n    model: ${MODEL}\n`,
    'utf-8',
  );
  mkdirSync(join(homeDir, '.ok'), { recursive: true });

  server = await createTestServer({ contentDir, configHomedirOverride: homeDir });
  // Store the key through the real route so it binds to THIS project + endpoint
  // (a flat OPENAI_API_KEY would not resolve for a custom endpoint by design).
  await fetch(`http://127.0.0.1:${server.port}/api/local-op/embeddings/set-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'sk-test-probe-key' }),
  });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
  await provider.close();
  rmSync(contentDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

async function postTest(body: unknown = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/local-op/embeddings/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('local-op-embeddings-test', () => {
  test('reports success plus the vector size the endpoint actually returned', async () => {
    const res = await postTest();
    expect(res.status).toBe(200);
    const parsed = LocalOpEmbeddingsTestResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || !parsed.data.ok) throw new Error('expected a successful probe');
    expect(parsed.data.dimensions).toBe(PROVIDER_DIMS);
    // Echoed so the UI can tell a verdict for the saved endpoint apart from one
    // for an edit that hasn't reached the server yet.
    expect(parsed.data.endpoint).toBe(provider.baseUrl);
    expect(parsed.data.model).toBe(MODEL);
  });

  test('sends the configured model, a Bearer key, and only a fixed probe string', async () => {
    const before = provider.requests.length;
    await postTest();
    const request = provider.requests[before];
    expect(request.model).toBe(MODEL);
    expect(request.authorization).toBe('Bearer sk-test-probe-key');
    expect(request.input).toHaveLength(1);
    // No page text and no user query may ride along to an endpoint under test.
    expect(request.input[0]).not.toContain('test-doc');
  });

  test('does not read an endpoint from the request body', async () => {
    // A body-supplied endpoint paired with the stored key would turn this route
    // into a key-exfiltration oracle for anything that can reach loopback.
    const before = provider.requests.length;
    const res = await postTest({ baseUrl: 'https://attacker.example/v1' });
    const parsed = LocalOpEmbeddingsTestResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.endpoint).toBe(provider.baseUrl);
    expect(provider.requests.length).toBe(before + 1); // the saved endpoint got it
  });

  test('malformed JSON body emits problem+json 400', async () => {
    const res = await postTest('not-valid-json{');
    expect(res.status).toBe(400);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.status).toBe(400);
  });

  test('GET is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/embeddings/test`);
    expect(res.status).toBe(405);
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe('urn:ok:error:method-not-allowed');
  });
});

describe('local-op-embeddings-test — provider failure', () => {
  let failing: FakeEmbeddingsServer;
  let failingServer: TestServer;
  let failingContentDir: string;
  let failingHomeDir: string;

  beforeAll(async () => {
    failing = await startFakeEmbeddingsServer({ dims: PROVIDER_DIMS, failWithStatus: 401 });
    failingContentDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-content-'));
    failingHomeDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-home-'));
    mkdirSync(join(failingContentDir, '.ok', 'local'), { recursive: true });
    writeFileSync(join(failingContentDir, '.ok', 'config.yml'), '', 'utf-8');
    writeFileSync(
      join(failingContentDir, '.ok', 'local', 'config.yml'),
      `search:\n  semantic:\n    enabled: true\n    baseUrl: ${failing.baseUrl}\n`,
      'utf-8',
    );
    mkdirSync(join(failingHomeDir, '.ok'), { recursive: true });
    failingServer = await createTestServer({
      contentDir: failingContentDir,
      configHomedirOverride: failingHomeDir,
    });
    await fetch(`http://127.0.0.1:${failingServer.port}/api/local-op/embeddings/set-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'sk-bad' }),
    });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await failingServer.cleanup();
    await failing.close();
    rmSync(failingContentDir, { recursive: true, force: true });
    rmSync(failingHomeDir, { recursive: true, force: true });
  });

  test('a rejected key comes back classified, with the status, at HTTP 200', async () => {
    const res = await fetch(`http://127.0.0.1:${failingServer.port}/api/local-op/embeddings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    // The probe reached a verdict — that is a successful test with a negative
    // result, not a server error.
    expect(res.status).toBe(200);
    const parsed = LocalOpEmbeddingsTestResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.ok) throw new Error('expected a failed probe');
    expect(parsed.data.reason).toBe('http_error');
    expect(parsed.data.status).toBe(401);
  });
});

describe('local-op-embeddings-test — no key configured', () => {
  let noKeyServer: TestServer;
  let noKeyContentDir: string;
  let noKeyHomeDir: string;

  beforeAll(async () => {
    noKeyContentDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-content-'));
    noKeyHomeDir = mkdtempSync(join(tmpdir(), 'ok-emb-test-home-'));
    mkdirSync(join(noKeyContentDir, '.ok', 'local'), { recursive: true });
    writeFileSync(join(noKeyContentDir, '.ok', 'config.yml'), '', 'utf-8');
    // A NON-loopback endpoint with no key — keyless doesn't apply, so the route
    // must report `no_key` WITHOUT making a network call.
    writeFileSync(
      join(noKeyContentDir, '.ok', 'local', 'config.yml'),
      'search:\n  semantic:\n    enabled: true\n    baseUrl: https://api.openai.com/v1\n',
      'utf-8',
    );
    mkdirSync(join(noKeyHomeDir, '.ok'), { recursive: true });
    noKeyServer = await createTestServer({
      contentDir: noKeyContentDir,
      configHomedirOverride: noKeyHomeDir,
    });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await noKeyServer.cleanup();
    rmSync(noKeyContentDir, { recursive: true, force: true });
    rmSync(noKeyHomeDir, { recursive: true, force: true });
  });

  test('reports no_key (no network call) when no key is stored for a remote endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${noKeyServer.port}/api/local-op/embeddings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const parsed = LocalOpEmbeddingsTestResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.ok) throw new Error('expected a failed probe');
    expect(parsed.data.reason).toBe('no_key');
  });
});
