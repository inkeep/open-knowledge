import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed link/graph read group over a REAL
 * socket through the composed `bootServer` stack. These routes left the
 * legacy dispatch registry when they moved to the Hono mount, so a 200 here
 * is proof of native serving — a wiring gap would surface as the legacy
 * dispatch's 404. The admission-gate pins mirror
 * `api-admission-composition.test.ts` on a ported route, closing the exact
 * bypass the native mount exists to prevent.
 */

let tmpRoot: string;
let normal: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-linkgraph-native-'));

  const normalDir = mkdtempSync(resolve(tmpRoot, 'normal-'));
  writeFileSync(resolve(normalDir, 'alpha.md'), '# Alpha\n\nLinks to [[beta]].\n', 'utf-8');
  writeFileSync(resolve(normalDir, 'beta.md'), '# Beta\n\nBody.\n', 'utf-8');
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

describe('link/graph group over the composed listener — served natively', () => {
  test('every static route in the group answers (absent from the legacy registry)', async () => {
    for (const path of [
      '/api/backlinks?docName=beta',
      '/api/backlink-counts?docNames=alpha,beta',
      '/api/forward-links?docName=alpha',
      '/api/link-graph',
      '/api/dead-links',
      '/api/orphans',
      '/api/hubs',
      '/api/tags',
      '/api/suggest-links?docName=alpha',
    ]) {
      const res = await fetch(`http://127.0.0.1:${normal.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('the parametric tags route answers; the empty tail 404s under the typed envelope', async () => {
    const named = await fetch(`http://127.0.0.1:${normal.port}/api/tags/some-tag`);
    expect(named.status).toBe(200);

    const empty = await fetch(`http://127.0.0.1:${normal.port}/api/tags/`);
    expect(empty.status).toBe(404);
    expect(empty.headers.get('content-type')).toBe('application/problem+json');
    expect(((await empty.json()) as { type?: string }).type).toBe('urn:ok:error:not-found');
  });

  test('method gate holds on the native mount (POST answers 405 + Allow: GET)', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/backlinks`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/backlinks?docName=beta`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:invalid-origin');
  });

  test('allowed browser Origin gets CORS reflection on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/backlinks?docName=beta`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/backlinks`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('any forwarding header trips the proxied-request refusal on a ported route', async () => {
    const res = await rawRequest(normal.port, '/api/backlinks?docName=beta', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('read posture parity: a ported route under a rebound Host is refused in normal mode', async () => {
    // Flipped pin (read-posture hardening): reads share the mutating gate's
    // Host predicate in every mode, so a rebound Host is refused on ported
    // reads too.
    const res = await rawRequest(normal.port, '/api/backlinks?docName=beta', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('ephemeral mode Host-gates the ported reads too', async () => {
    const res = await rawRequest(ephemeral.port, '/api/backlinks?docName=note', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });
});
