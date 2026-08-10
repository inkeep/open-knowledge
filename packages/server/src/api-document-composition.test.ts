import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed document/pages read group over a REAL
 * socket through the composed `bootServer` stack — the THIRD native group in
 * the chained `nativeApi` dispatch. A 200 here proves native serving (these
 * paths left the legacy registry) and that the first two groups' tables
 * decline these URLs cleanly. Mirrors `api-link-graph-composition.test.ts` /
 * `api-metrics-composition.test.ts` for the earlier groups' pins.
 *
 * `document-list` is the group's heavyweight (ready-gate park, showAll walks,
 * referenced-assets cache) — the pins here cover its plain path, the showAll
 * buffered path, and the streaming NDJSON negotiation; the walk internals
 * keep their dedicated suites (`showall-*.test.ts`, single-flight
 * integration).
 */

let tmpRoot: string;
let server: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-document-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(
    resolve(contentDir, 'alpha.md'),
    '# Alpha Title\n\n## Section One\n\nBody.\n',
    'utf-8',
  );
  writeFileSync(resolve(contentDir, 'beta.md'), '# Beta\n\nBody.\n', 'utf-8');
  // A doc inside a BUILTIN_SKIP_DIRS member: the watcher never indexes it, but
  // the showAll walk's `bypassFilters: true` traversal surfaces it — the
  // differential row that proves the buffered showAll branch actually ran
  // (status + content-type alone can't discriminate it from the index path).
  mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
  writeFileSync(resolve(contentDir, 'dist', 'generated.md'), '# Generated\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;

  const ephemeralDir = mkdtempSync(resolve(tmpRoot, 'ephemeral-'));
  writeFileSync(resolve(ephemeralDir, 'note.md'), '# note\n', 'utf-8');
  ephemeral = await bootCompositionRig(ephemeralDir, {
    ephemeral: true,
    singleDocRelPath: 'note.md',
  });
  await ephemeral.ready;
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([server?.destroy(), ephemeral?.destroy()]);
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('document/pages group over the composed listener — served natively', () => {
  test('every route in the group answers (absent from the legacy registry)', async () => {
    for (const path of [
      '/api/document?docName=alpha',
      '/api/documents',
      '/api/pages',
      '/api/page-headings?docName=alpha',
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('all three chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${server.port}/api/metrics/reconciliation`);
    expect(metrics.status).toBe(200);
    const documents = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(documents.status).toBe(200);
  });

  test('document read returns the doc content; unknown doc 404s typed', async () => {
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=alpha`);
    const body = (await ok.json()) as { docName?: string; content?: string };
    expect(body.docName).toBe('alpha');
    expect(body.content).toContain('# Alpha Title');

    const missing = await fetch(`http://127.0.0.1:${server.port}/api/document?docName=nope`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/problem+json');
    expect(((await missing.json()) as { type?: string }).type).toBe('urn:ok:error:doc-not-found');
  });

  test('documents lists both docs; pages carries derived titles; headings extract', async () => {
    const documents = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/documents`)
    ).json()) as { documents: Array<{ docName?: string }> };
    const names = documents.documents.map((d) => d.docName);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');

    const pages = (await (await fetch(`http://127.0.0.1:${server.port}/api/pages`)).json()) as {
      pages: Array<{ docName: string; title: string }>;
    };
    expect(pages.pages.find((p) => p.docName === 'alpha')?.title).toBe('Alpha Title');

    const headings = (await (
      await fetch(`http://127.0.0.1:${server.port}/api/page-headings?docName=alpha`)
    ).json()) as { headings: Array<{ text: string }> };
    expect(headings.headings.map((h) => h.text)).toContain('Section One');
  });

  test('showAll buffered walk and streaming NDJSON negotiation both serve natively', async () => {
    // The dist/ doc discriminates the branch: absent from the watcher-indexed
    // plain listing, present only when the bypassFilters showAll walk ran.
    const plain = (await (await fetch(`http://127.0.0.1:${server.port}/api/documents`)).json()) as {
      documents: Array<{ docName?: string; path?: string }>;
    };
    const plainNames = plain.documents.map((d) => d.docName ?? d.path);
    expect(plainNames).not.toContain('dist/generated');

    const buffered = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`);
    expect(buffered.status).toBe(200);
    expect(buffered.headers.get('content-type')).toBe('application/json');
    const bufferedBody = (await buffered.json()) as {
      documents: Array<{ docName?: string; path?: string }>;
    };
    const bufferedNames = bufferedBody.documents.map((d) => d.docName ?? d.path);
    expect(bufferedNames).toContain('dist/generated');

    const streamed = await fetch(`http://127.0.0.1:${server.port}/api/documents?showAll=true`, {
      headers: { Accept: 'application/x-ndjson' },
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toBe('application/x-ndjson');
    const text = await streamed.text();
    const lines = text.trim().split('\n');
    // Same dist/ discriminator as the buffered branch: the row only exists
    // when the bypassFilters walk ran, so both showAll paths carry
    // symmetric proof.
    const streamedNames = lines
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { docName?: string; path?: string })
      .map((entry) => entry.docName ?? entry.path);
    expect(streamedNames).toContain('dist/generated');
    const terminal = JSON.parse(lines[lines.length - 1] ?? '{}') as { type?: string };
    expect(terminal.type).toBe('complete');
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('any forwarding header trips the proxied-request refusal on a ported route', async () => {
    const res = await rawRequest(server.port, '/api/documents', {
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('method gate holds on the native mount (POST answers 405 + Allow: GET)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pages`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  test('allowed browser Origin gets CORS reflection on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('read posture parity: a ported route under a rebound Host is refused in normal mode', async () => {
    // Flipped pin (read-posture hardening): reads share the mutating gate's
    // Host predicate in every mode, so a rebound Host is refused on ported
    // reads too.
    const res = await rawRequest(server.port, '/api/pages', {
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('ephemeral mode Host-gates the ported reads too', async () => {
    const refused = await rawRequest(ephemeral.port, '/api/documents', {
      headers: { Host: 'evil.example' },
    });
    expect(refused.status).toBe(403);
    expect(parseProblem(refused.body).type).toBe('urn:ok:error:host-not-allowed');

    const allowed = await rawRequest(ephemeral.port, '/api/documents', {
      headers: { Host: 'localhost' },
    });
    expect(allowed.status).toBe(200);
  });
});
