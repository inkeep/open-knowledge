import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

const READ_GETS = [
  '/api/lint/config',
  '/api/lint/frontmatter-schemas',
  '/api/lint?doc=alpha',
  '/api/lint/audit',
  '/api/audit',
];

const ALL_ROUTES = [
  '/api/lint/config',
  '/api/lint/frontmatter-schemas',
  '/api/lint',
  '/api/lint/audit',
  '/api/audit',
];

const WRITE_POSTS = [
  '/api/lint/markdownlint-config',
  '/api/lint/frontmatter-schema',
  '/api/lint/fix',
];

let tmpRoot: string;
let server: BootedServer;
let external: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-lint-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  const externalDir = mkdtempSync(resolve(tmpRoot, 'external-'));
  external = await bootCompositionRig(externalDir, {
    serverRuntime: {
      bind: ['127.0.0.1'],
      port: 0,
      externalUrl: 'https://lint.example.com',
      allowExternal: true,
      openBrowser: false,
      idleShutdown: 'off',
      loopbackOnly: true,
    },
  });
  await Promise.all([server.ready, external.ready]);
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([server?.destroy(), external?.destroy()]);
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
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const lintConfig = await fetch(`http://127.0.0.1:${server.port}/api/lint/config`);
    expect(lintConfig.status).toBe(200);
  });

  test('the three writes retain conditional admission under external consent', async () => {
    for (const path of WRITE_POSTS) {
      const refused = await rawRequest(external.port, path, {
        method: 'OPTIONS',
        headers: {
          Host: 'evil.example',
          Origin: 'https://lint.example.com',
          'X-Forwarded-For': '203.0.113.8',
          'X-Request-Id': 'outer-refusal',
        },
      });
      expect(refused.status, `${path}: ${refused.body}`).toBe(403);
      expect(refused.headers['x-request-id']).toBeUndefined();
      expect(refused.headers['access-control-allow-origin']).toBeUndefined();
      expect(parseProblem(refused.body).type).toBe('urn:ok:error:host-not-allowed');

      const origin = await rawRequest(external.port, path, {
        method: 'PATCH',
        headers: {
          Host: 'lint.example.com',
          Origin: 'https://evil.example',
          'X-Forwarded-For': '203.0.113.8',
          'X-Request-Id': 'origin-refusal',
        },
        body: '{',
      });
      expect(origin.status, `${path}: ${origin.body}`).toBe(403);
      expect(origin.headers['x-request-id']).toBe('origin-refusal');
      expect(origin.headers['access-control-allow-origin']).toBeUndefined();
      expect(parseProblem(origin.body).type).toBe('urn:ok:error:invalid-origin');

      const wrongMethod = await rawRequest(external.port, path, {
        method: 'PATCH',
        headers: {
          Host: 'lint.example.com',
          Origin: 'https://lint.example.com',
          'X-Forwarded-For': '203.0.113.8',
        },
        body: '{',
      });
      expect(wrongMethod.status, `${path}: ${wrongMethod.body}`).toBe(405);
      expect(wrongMethod.headers.allow).toBe('POST');
      expect(wrongMethod.headers['access-control-allow-origin']).toBe('https://lint.example.com');

      const preflight = await rawRequest(external.port, path, {
        method: 'OPTIONS',
        headers: {
          Host: 'lint.example.com',
          Origin: 'https://lint.example.com',
          'X-Forwarded-For': '203.0.113.8',
        },
      });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('https://lint.example.com');
    }
  });
});
