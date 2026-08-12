import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the `/api/*` admission gates as experienced over a REAL
 * socket through the composed `bootServer` stack. The gates themselves have
 * unit coverage (predicates) and in-process coverage (`api-request-id.test.ts`
 * invokes `onRequest` directly), but before this suite no test drove them
 * through the actual listener + mcp-mount dispatch + api-extension chain —
 * the exact layering the server refactor rewires. Assertions pin CURRENT
 * behavior — including the read-posture hardening (reads are Host-gated in
 * every mode, the no-auth compensating control): if one of these starts
 * failing, the admission surface changed and the change must be intentional.
 */

let tmpRoot: string;
let normal: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-admission-'));

  const normalDir = mkdtempSync(resolve(tmpRoot, 'normal-'));
  normal = await bootCompositionRig(normalDir);
  await normal.ready;

  const ephemeralDir = mkdtempSync(resolve(tmpRoot, 'ephemeral-'));
  writeFileSync(resolve(ephemeralDir, 'note.md'), '# note\n', 'utf-8');
  ephemeral = await bootCompositionRig(ephemeralDir, {
    ephemeral: true,
    singleDocRelPath: 'note.md',
  });
  await ephemeral.ready;
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([normal?.destroy(), ephemeral?.destroy()]);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('/api admission over the composed listener — normal mode', () => {
  test('read route with a foreign Origin is refused before dispatch', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/server-info`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = (await res.json()) as { type?: string; title?: string };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
    expect(body.title).toBe('Origin not allowed.');
  });

  test('read route with an allowed browser Origin gets CORS reflection', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/server-info`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('read route under a rebound Host is refused (read-posture hardening)', async () => {
    // Flipped pin: reads are Host-gated in every mode now, same predicate the
    // mutating gate uses (loopback names + bind literals + externalUrl host).
    // A DNS-rebound page's no-Origin fetch can no longer read /api bodies —
    // the no-auth compensating control.
    const res = await rawRequest(normal.port, '/api/server-info', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('mutating route under a rebound Host is refused', async () => {
    const res = await rawRequest(normal.port, '/api/create-page', {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
  });

  test('mutating route with loopback Host passes the gate (fails later on payload, not admission)', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/create-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  test('local-op prefix routes are Host-gated as a family', async () => {
    const res = await rawRequest(normal.port, '/api/local-op/auth/status', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('host-disclosing read handler /api/workspace carries its own inline Host gate', async () => {
    const res = await rawRequest(normal.port, '/api/workspace', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('any forwarding header trips the proxied-request refusal on /api', async () => {
    const res = await rawRequest(normal.port, '/api/server-info', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('OPTIONS preflight on an /api route answers 204 with CORS methods', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/create-page`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('OPTIONS under a rebound Host still answers 204 — safe by CORS, not by the read gate', async () => {
    // Documents the intentional gate ORDER: the OPTIONS short-circuit (step 3)
    // returns 204 before the read gate (step 5), so a rebound-Host preflight is
    // NOT 403'd. This is not a hole: no Origin was sent, so no
    // Access-Control-Allow-Origin is reflected, and the rebound page's browser
    // gets no CORS grant to read any follow-up response. (A present-but-foreign
    // Origin is rejected by the Origin gate at step 3 instead.)
    const res = await rawRequest(normal.port, '/api/server-info', {
      method: 'OPTIONS',
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('/api admission over the composed listener — ephemeral mode', () => {
  test('read route via localhost is served', async () => {
    const res = await fetch(`http://127.0.0.1:${ephemeral.port}/api/server-info`);
    expect(res.status).toBe(200);
  });

  test('EVERY /api route is Host-gated, including reads', async () => {
    // The ephemeral contentDir is the opened file's parent directory, so the
    // normal-mode read posture would let a rebound page enumerate sibling
    // files. Ephemeral mode therefore gates all of /api, not just mutations.
    const res = await rawRequest(ephemeral.port, '/api/server-info', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('/mcp is unmounted in ephemeral mode', async () => {
    const res = await fetch(`http://127.0.0.1:${ephemeral.port}/mcp`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(404);
  });
});
