import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed version-history read group over the
 * composed `bootServer` stack. This is the SECOND native group to carry a
 * DYNAMIC legacy prefix — `link-graph-routes.ts`'s `/api/tags/:name` was the
 * first; both use a Hono `/api/*` wildcard whose table `resolve` re-expresses
 * the legacy fall-through. The two diverge on malformed input by design:
 * `tags` returns a typed 400, while `history/:sha` keeps the legacy generic
 * 500 (sha decode inside `dispatch`) to hold byte parity with the lifted
 * handler.
 *
 * The shared `/api/*` admission gates are owned by
 * `api-admission-composition.test.ts`; this suite pins only what discriminates
 * the group: native registration of both the exact route and the dynamic
 * prefix, and the read/edge-case statuses.
 */

const A_SHA = 'a'.repeat(40);

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-history-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('history group over the composed listener — served natively', () => {
  test('both the exact route and the dynamic prefix answer a wrong method with 405 + Allow: GET', async () => {
    // Registration proof: an unregistered path returns the pipeline's generic
    // `/api/*` 404; a registered route (exact or dynamic) 405s the wrong verb.
    for (const path of ['/api/history', `/api/history/${A_SHA}`]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('GET');
    }
  });

  test('the exact route serves a 200 timeline natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=alpha`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('the dynamic /api/history/:sha prefix reaches handleHistoryVersion natively', async () => {
    // A 40-hex sha resolves through the `/api/history/*` wildcard to
    // handleHistoryVersion, which emits its OWN `doc-not-found` 404 for an
    // absent commit — distinct from the pipeline route-miss `not-found`, so
    // this proves the dynamic leg dispatches out of the legacy resolve
    // fall-through and into the native handler.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history/${A_SHA}?docName=alpha`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:doc-not-found');
  });

  test('an empty sha (`/api/history/`) resolves to the :sha template with no dispatch (404)', async () => {
    // Preserves the legacy edge case: empty tail → no dispatch → the pipeline's
    // explicit 404 under the `/api/history/:sha` template.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/history/`);
    expect(res.status).toBe(404);
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const history = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=alpha`);
    expect(history.status).toBe(200);
  });
});
