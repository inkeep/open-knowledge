import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

const READS = ['/api/agent-activity', '/api/agent-burst-diff'];
const WRITES = [
  '/api/agent-write-md',
  '/api/frontmatter-patch',
  '/api/agent-patch',
  '/api/agent-undo',
  '/api/save-version',
  '/api/rollback',
];
const TEST_PATHS = [
  '/api/test-reset',
  '/api/test-flush-git',
  '/api/test-rescan-backlinks',
  '/api/test-rescan-files',
];
const RESIDUAL = [
  '/api/skill/uninstall',
  '/api/agent-write',
  '/api/agent-write-batch',
  '/api/lint/markdownlint-config',
  '/api/lint/frontmatter-schema',
  '/api/lint/fix',
  '/api/agent-integrations/apply',
];
let root: string;
let enabled: BootedServer;
let disabled: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-agent-native-preservation-'));
  for (const name of ['enabled', 'disabled', 'ephemeral']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'ephemeral', 'note.md'), '# Note\n');
  enabled = await bootCompositionRig(join(root, 'enabled'), { enableTestRoutes: true });
  disabled = await bootCompositionRig(join(root, 'disabled'));
  ephemeral = await bootCompositionRig(join(root, 'ephemeral'), {
    ephemeral: true,
    singleDocRelPath: 'note.md',
  });
  await Promise.all([enabled.ready, disabled.ready, ephemeral.ready]);
}, 60_000);

afterAll(async () => {
  await Promise.allSettled([enabled?.destroy(), disabled?.destroy(), ephemeral?.destroy()]);
  rmSync(root, { recursive: true, force: true });
});

test('native ownership is exclusive and the remaining legacy registry matches its explicit owners', () => {
  for (const server of [enabled, disabled]) {
    for (const path of [...READS, ...WRITES, '/api/asset', '/api/asset-text'])
      expect(server.serverInstance.nativeApi.paths.filter((entry) => entry === path)).toHaveLength(
        1,
      );
    for (const path of RESIDUAL) expect(server.serverInstance.nativeApi.paths).not.toContain(path);
  }
  for (const path of TEST_PATHS) {
    expect(enabled.serverInstance.nativeApi.paths).toContain(path);
    expect(disabled.serverInstance.nativeApi.paths).not.toContain(path);
  }
  const source = readFileSync(new URL('./api-extension.ts', import.meta.url), 'utf8');
  const registry = source.match(/const routes:[\s\S]*?= (\{[\s\S]*?\n {2}\});/)?.[1];
  expect(registry).toBeDefined();

  expect(
    [...(registry?.matchAll(/'([^']*\/api\/[^']*)'/g) ?? [])].map((match) => match[1]).sort(),
  ).toEqual([...RESIDUAL].sort());
});

test('ingress rejects every migrated route before method or malformed-body admission', async () => {
  for (const path of [...READS, ...WRITES, ...TEST_PATHS, '/api/asset', '/api/asset-text']) {
    for (const [headers, type] of [
      [{ Host: 'evil.example' }, 'urn:ok:error:host-not-allowed'],
      [{ Origin: 'https://evil.example' }, 'urn:ok:error:invalid-origin'],
      [{ 'X-Forwarded-For': '127.0.0.1' }, 'urn:ok:error:host-not-allowed'],
    ] as const) {
      const response = await rawRequest(enabled.port, path, {
        method: 'PATCH',
        headers,
        body: '{',
      });
      expect(response.status, `${path}: ${response.body}`).toBe(403);
      expect(response.headers.allow).toBeUndefined();
      expect(parseProblem(response.body).type).toBe(type);
    }
  }
});

test('methods, preflight, HEAD and request IDs retain the transport contracts', async () => {
  for (const path of [...READS, ...WRITES, ...TEST_PATHS]) {
    const allowed = READS.includes(path) ? 'GET' : 'POST';
    const wrong = await rawRequest(enabled.port, path, {
      method: 'PATCH',
      headers: { 'X-Request-Id': 'spine-method' },
      body: '{',
    });
    expect(wrong.status, `${path}: ${wrong.body}`).toBe(405);
    expect(wrong.headers.allow).toBe(allowed);
    expect(wrong.headers['x-request-id']).toBe('spine-method');
    expect(parseProblem(wrong.body).type).toBe('urn:ok:error:method-not-allowed');
    const head = await rawRequest(enabled.port, path, { method: 'HEAD' });
    expect(head.status, path).toBe(405);
    expect(head.body).toBe('');
    const preflight = await rawRequest(enabled.port, path, { method: 'OPTIONS' });
    expect(preflight.status, path).toBe(204);
  }
});

test('disabled test routes retain unknown-path admission, in ephemeral servers', async () => {
  for (const path of TEST_PATHS) {
    const unknown = await rawRequest(disabled.port, path, { method: 'POST', body: '{' });
    expect(unknown.status, unknown.body).toBe(404);
    expect(parseProblem(unknown.body).type).toBe('urn:ok:error:not-found');
    const rejected = await rawRequest(disabled.port, path, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '{',
    });
    expect(rejected.status).toBe(403);
    expect(parseProblem(rejected.body).type).toBe('urn:ok:error:invalid-origin');
    const restricted = await rawRequest(ephemeral.port, path, { method: 'POST', body: '{' });
    expect(restricted.status, restricted.body).toBe(404);
  }
  for (const path of WRITES) {
    const response = await rawRequest(ephemeral.port, path, { method: 'POST', body: '{' });
    expect(response.status, `${path}: ${response.body}`).toBe(400);
  }
  for (const path of READS) {
    const response = await rawRequest(ephemeral.port, path);
    expect(response.status, `${path}: ${response.body}`).toBe(400);
  }
});

test('enabled reset and rescans execute against real sessions, files and indexes', async () => {
  const docName = 'reset-spine';
  const write = await rawRequest(enabled.port, '/api/agent-write-md', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName,
      markdown: '# Reset me\n',
      agentId: 'reset',
      position: 'replace',
    }),
  });
  expect(write.status, write.body).toBe(200);
  expect(enabled.serverInstance.sessionManager.hasSession(docName, 'agent-reset')).toBe(true);
  const reset = await rawRequest(
    enabled.port,
    `/api/test-reset?docName=${docName}&reset-okignore=false`,
    { method: 'POST', body: '{' },
  );
  expect(reset.status, reset.body).toBe(200);
  expect(enabled.serverInstance.sessionManager.hasSession(docName, 'agent-reset')).toBe(false);
  expect(readFileSync(join(root, 'enabled', `${docName}.md`), 'utf8')).toBe('');
  writeFileSync(
    join(root, 'enabled', 'discovered.md'),
    '# Discovered\n\n[Reset](reset-spine.md)\n',
  );
  for (const path of [
    '/api/test-rescan-files',
    '/api/test-rescan-backlinks',
    '/api/test-flush-git',
  ]) {
    const response = await rawRequest(enabled.port, path, { method: 'POST', body: '{' });
    expect(response.status, `${path}: ${response.body}`).toBe(200);
    expect(JSON.parse(response.body)).toEqual({});
  }
  const files = await rawRequest(enabled.port, '/api/documents');
  expect(files.status, files.body).toBe(200);
  expect(files.body).toContain('discovered');
  const backlinks = await rawRequest(enabled.port, '/api/backlinks?docName=reset-spine');
  expect(backlinks.status, backlinks.body).toBe(200);
  expect(backlinks.body).toContain('discovered');
});
