import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
} from './composition-rig.test-helper.ts';

let root: string;
let server: BootedServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-lint-config-preservation-'));
  const contentDir = join(root, 'composition');
  mkdirSync(contentDir);
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(root, { recursive: true, force: true });
});

function createRig(
  overrides: { getLinterBaseConfig?: () => never; signalChannel?: (channel: string) => void } = {},
) {
  const contentDir = mkdtempSync(join(root, 'content-'));
  const homeDirOverride = mkdtempSync(join(root, 'home-'));
  const extension = createApiExtension({
    contentDir,
    projectDir: contentDir,
    homeDirOverride,
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
    ...overrides,
  });
  return { contentDir, extension };
}

async function post(
  extension: ReturnType<typeof createApiExtension>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = makeSyntheticReq({ method: 'POST', url: path });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: path,
    headers: { ...base.headers, 'content-type': 'application/json' },
    socket: base.socket,
  }) as IncomingMessage;
  const { res, captured } = makeCaptureRes();
  await extension.onRequest({ request: req, response: res });
  return {
    status: captured.status,
    body: JSON.parse(captured.body) as Record<string, unknown>,
  };
}

test('accepted config actions preserve their synchronous invalidation schedule', async () => {
  const signals: string[] = [];
  const { contentDir, extension } = createRig({
    signalChannel: (channel) => signals.push(channel),
  });

  const markdown = await post(extension, '/api/lint/markdownlint-config', {
    ruleId: 'MD012',
    value: false,
  });
  expect(markdown.status).toBe(200);
  expect(signals.splice(0)).toEqual(['lint-config']);

  const file = '.ok/schemas/signals.schema.json';
  const created = await post(extension, '/api/lint/frontmatter-schema', { file });
  expect(created.status).toBe(200);
  expect(signals.splice(0)).toEqual(['files', 'lint-config']);

  const noop = await post(extension, '/api/lint/frontmatter-schema', { file });
  expect(noop.status).toBe(200);
  expect(signals.splice(0)).toEqual(['lint-config']);

  const written = await post(extension, '/api/lint/frontmatter-schema', {
    file,
    field: 'status',
    constraint: { type: 'string' },
  });
  expect(written.status).toBe(200);
  expect(signals.splice(0)).toEqual(['lint-config']);

  const deleted = await post(extension, '/api/lint/frontmatter-schema', {
    file,
    delete: true,
  });
  expect(deleted.status).toBe(200);
  expect(signals.splice(0)).toEqual(['files', 'lint-config']);

  const idempotentDelete = await post(extension, '/api/lint/frontmatter-schema', {
    file,
    delete: true,
  });
  expect(idempotentDelete.status).toBe(200);
  expect(signals.splice(0)).toEqual(['files', 'lint-config']);

  writeFileSync(join(contentDir, '.markdownlint.json'), JSON.stringify({ MD012: false }));
  const removed = await post(extension, '/api/lint/markdownlint-config', {
    ruleId: 'MD012',
    value: null,
  });
  expect(removed.status).toBe(200);
  expect(signals.splice(0)).toEqual(['lint-config']);

  const markdownNoop = await post(extension, '/api/lint/markdownlint-config', {
    ruleId: 'MD012',
    value: null,
  });
  expect(markdownNoop.status).toBe(200);
  expect(signals).toEqual(['lint-config']);
});

test('refused and failed config writes leave accepted-write invalidation silent', async () => {
  const markdownSignals: string[] = [];
  const markdownRig = createRig({
    signalChannel: (channel) => markdownSignals.push(channel),
  });
  writeFileSync(
    join(markdownRig.contentDir, '.markdownlint.cjs'),
    'module.exports = { MD012: false };\n',
  );
  const declined = await post(markdownRig.extension, '/api/lint/markdownlint-config', {
    ruleId: 'MD012',
    value: true,
  });
  expect(declined.status).toBe(409);
  expect(declined.body.type).toBe('urn:ok:error:config-not-writable');
  expect(markdownSignals).toEqual([]);

  const frontmatterSignals: string[] = [];
  const frontmatterRig = createRig({
    signalChannel: (channel) => frontmatterSignals.push(channel),
  });
  const refused = await post(frontmatterRig.extension, '/api/lint/frontmatter-schema', {
    file: '../escape.schema.json',
  });
  expect(refused.status).toBe(409);
  expect(refused.body.type).toBe('urn:ok:error:config-not-writable');
  expect(frontmatterSignals).toEqual([]);

  const markdownFailureSignals: string[] = [];
  const markdownFailureRig = createRig({
    signalChannel: (channel) => markdownFailureSignals.push(channel),
  });
  mkdirSync(join(markdownFailureRig.contentDir, '.markdownlint.json'));
  const markdownFailure = await post(
    markdownFailureRig.extension,
    '/api/lint/markdownlint-config',
    { ruleId: 'MD012', value: false },
  );
  expect(markdownFailure.status).toBe(500);
  expect(markdownFailure.body.title).toBe('Failed to write markdownlint config.');
  expect(markdownFailureSignals).toEqual([]);

  const frontmatterFailureSignals: string[] = [];
  const frontmatterFailureRig = createRig({
    signalChannel: (channel) => frontmatterFailureSignals.push(channel),
  });
  writeFileSync(join(frontmatterFailureRig.contentDir, '.ok'), 'not a directory');
  const frontmatterFailure = await post(
    frontmatterFailureRig.extension,
    '/api/lint/frontmatter-schema',
    { file: '.ok/schemas/failure.schema.json' },
  );
  expect(frontmatterFailure.status).toBe(500);
  expect(frontmatterFailure.body.title).toBe('Failed to write the frontmatter schema.');
  expect(frontmatterFailureSignals).toEqual([]);
});

test('saved config changes and invalidation survive an effective-config reread failure', async () => {
  const markdownSignals: string[] = [];
  const markdownRig = createRig({
    getLinterBaseConfig: () => {
      throw new Error('controlled reread failure');
    },
    signalChannel: (channel) => markdownSignals.push(channel),
  });
  const markdown = await post(markdownRig.extension, '/api/lint/markdownlint-config', {
    ruleId: 'MD012',
    value: false,
  });
  expect(markdown.status).toBe(500);
  expect(markdown.body.title).toBe(
    'The markdownlint rule was saved, but the effective config could not be re-read.',
  );
  expect(readFileSync(join(markdownRig.contentDir, '.markdownlint.json'), 'utf-8')).toContain(
    '"MD012": false',
  );
  expect(markdownSignals).toEqual(['lint-config']);

  const frontmatterSignals: string[] = [];
  const frontmatterRig = createRig({
    getLinterBaseConfig: () => {
      throw new Error('controlled reread failure');
    },
    signalChannel: (channel) => frontmatterSignals.push(channel),
  });
  const file = '.ok/schemas/saved.schema.json';
  const frontmatter = await post(frontmatterRig.extension, '/api/lint/frontmatter-schema', {
    file,
  });
  expect(frontmatter.status).toBe(500);
  expect(frontmatter.body.title).toBe(
    'The schema was saved, but the effective config could not be re-read.',
  );
  expect(existsSync(join(frontmatterRig.contentDir, file))).toBe(true);
  expect(frontmatterSignals).toEqual(['files', 'lint-config']);
});
