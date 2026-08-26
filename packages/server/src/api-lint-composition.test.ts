import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed lint + audit read group over the
 * composed `bootServer` stack — the earlier groups' tables decline these URLs
 * and the chain falls through here. These are all ungated reads (no inline
 * loopback/Host gate); the shared `/api/*` admission gates are owned by
 * `api-admission-composition.test.ts`, so this suite pins only what
 * discriminates the group: native registration and the read bodies.
 */

/** GET requests that serve a 200 read in the composition rig. */
const READ_GETS = [
  '/api/lint/config',
  '/api/lint/frontmatter-schemas',
  '/api/lint?doc=alpha',
  '/api/lint/audit',
  '/api/audit',
];

/** The base paths — method-gated, so a POST answers 405 when registered. */
const ALL_ROUTES = [
  '/api/lint/config',
  '/api/lint/frontmatter-schemas',
  '/api/lint',
  '/api/lint/audit',
  '/api/audit',
];

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-lint-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('lint group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (POST → 405 + Allow: GET)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toContain('GET');
    }
  });

  test('every read serves a 200 body natively (application/json + x-request-id)', async () => {
    for (const path of READ_GETS) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('application/json');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    // The link/graph group resolves first in the chain; this group only
    // answers after the earlier groups decline. One server, both arms live.
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const lintConfig = await fetch(`http://127.0.0.1:${server.port}/api/lint/config`);
    expect(lintConfig.status).toBe(200);
  });
});
