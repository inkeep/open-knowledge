import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
  parseProblem,
  rawRequest,
} from './composition-rig.test-helper.ts';

const SKILL_METHODS = [
  ['/api/skills', 'GET'],
  ['/api/skill', 'GET, PUT, POST, DELETE'],
  ['/api/skill-file', 'GET, PUT, DELETE'],
  ['/api/skill-file/rename', 'POST'],
  ['/api/skill/import', 'POST'],
  ['/api/skills/import-bulk', 'POST'],
  ['/api/skill/edit-external', 'POST'],
  ['/api/skill/duplicate', 'POST'],
  ['/api/skill/move-scope', 'POST'],
  ['/api/skill/install', 'POST'],
  ['/api/skill/restore', 'POST'],
  ['/api/skill/reimport', 'POST'],
  ['/api/skills/reimport-bulk', 'POST'],
  ['/api/skill/revert', 'POST'],
  ['/api/skill/track-in-git', 'POST'],
  ['/api/install-skill', 'POST'],
] as const;

let contentDir: string;
let server: BootedServer;

beforeAll(async () => {
  contentDir = await mkdtemp(resolve(tmpdir(), 'ok-skills-contract-'));
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(contentDir, { recursive: true, force: true });
});

describe('skills contracts over the composed listener', () => {
  test.each(SKILL_METHODS)('%s preserves HEAD refusal and preflight', async (path, allow) => {
    const head = await rawRequest(server.port, path, { method: 'HEAD' });
    expect(head.status).toBe(405);
    expect(head.headers.allow).toBe(allow);
    expect(head.body).toBe('');
    const options = await rawRequest(server.port, path, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(options.status).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(options.body).toBe('');
  });

  test('raw upload preserves its custom method envelope without Allow', async () => {
    const res = await rawRequest(server.port, '/api/skill-upload', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(parseProblem(res.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Use POST to upload a skill.',
    });
  });

  test('handoff admission refuses an absent peer before consuming the body', async () => {
    const extension = createApiExtension({
      contentDir,
      projectDir: contentDir,
      hocuspocus: server.serverInstance.hocuspocus,
      sessionManager: server.serverInstance.sessionManager,
    });
    const request = makeSyntheticReq({ method: 'POST', url: '/api/install-skill' });
    Object.defineProperty(request.socket, 'remoteAddress', { value: undefined });
    const { res, captured } = makeCaptureRes();
    await extension.onRequest({ request, response: res });
    expect(captured.status).toBe(403);
    expect(parseProblem(captured.body)).toMatchObject({
      type: 'urn:ok:error:loopback-required',
      title: 'Local-op endpoints require a loopback connection.',
    });
    expect(request.readableEnded).toBe(false);
    request.destroy();
  });

  test('null Origin reaches catalog install and import validation but is refused by handoff admission', async () => {
    for (const path of ['/api/skill/install', '/api/skill/import']) {
      const catalog = await rawRequest(server.port, path, {
        method: 'POST',
        headers: { Origin: 'null', 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(catalog.status, `${path}: ${catalog.body}`).toBe(400);
      expect(parseProblem(catalog.body).type).toBe('urn:ok:error:invalid-request');
      expect(parseProblem(catalog.body).title).toBe('Request body is invalid.');
    }
    const handoff = await rawRequest(server.port, '/api/install-skill', {
      method: 'POST',
      headers: { Origin: 'null', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(handoff.status, handoff.body).toBe(403);
    expect(parseProblem(handoff.body).type).toBe('urn:ok:error:invalid-origin');
  });

  test('both install routes accept consented external origins before parsing malformed JSON', async () => {
    const externalDir = await mkdtemp(resolve(tmpdir(), 'ok-skills-external-contract-'));
    const external = await bootCompositionRig(externalDir, {
      serverRuntime: {
        bind: ['127.0.0.1'],
        port: 0,
        externalUrl: 'https://skills.example.com',
        allowExternal: true,
        openBrowser: false,
        idleShutdown: 'off',
        loopbackOnly: true,
      },
    });
    try {
      await external.ready;
      const headers = { Origin: 'https://skills.example.com', 'Content-Type': 'application/json' };
      const handoff = await rawRequest(external.port, '/api/install-skill', {
        method: 'POST',
        headers,
        body: '{',
      });
      expect(handoff.status).toBe(400);
      expect(parseProblem(handoff.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        title: 'Request body is not valid JSON.',
      });
      const catalog = await rawRequest(external.port, '/api/skill/install', {
        method: 'POST',
        headers,
        body: '{',
      });
      expect(catalog.status).toBe(400);
      expect(parseProblem(catalog.body).title).toBe('Request body is not valid JSON.');
    } finally {
      await external.destroy();
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  test('catalog install requires a name while handoff validates its output path', async () => {
    const body = JSON.stringify({
      noOpen: true,
      out: resolve(homedir(), '..', 'ok-skills-contract-output.skill'),
    });
    const headers = { 'Content-Type': 'application/json' };
    const catalog = await rawRequest(server.port, '/api/skill/install', {
      method: 'POST',
      headers,
      body,
    });
    expect(catalog.status).toBe(400);
    expect(parseProblem(catalog.body)).toMatchObject({ title: 'Request body is invalid.' });
    expect(parseProblem(catalog.body).detail).toContain('name');
    const handoff = await rawRequest(server.port, '/api/install-skill', {
      method: 'POST',
      headers,
      body,
    });
    expect(handoff.status).toBe(400);
    expect(parseProblem(handoff.body).title).toBe('Output path must be within home directory.');
  });

  test('JSON skill writes preserve the one-megabyte limit', async () => {
    const res = await rawRequest(server.port, '/api/skill', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'oversized', body: 'x'.repeat(1_048_576) }),
    });
    expect(res.status).toBe(413);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:payload-too-large');
  });

  test.each(['GET', 'DELETE'])('skill %s parses scope from the query', async (method) => {
    const res = await rawRequest(server.port, '/api/skill?name=missing&scope=invalid', { method });
    expect(res.status).toBe(400);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:invalid-request');
    expect(parseProblem(res.body).title).toContain('scope');
  });

  test.each(SKILL_METHODS.filter(([, methods]) => methods.includes('POST')))(
    '%s preserves malformed JSON errors',
    async (path) => {
      const res = await rawRequest(server.port, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'skills-json-contract' },
        body: '{',
      });
      expect(res.status).toBe(400);
      expect(res.headers['x-request-id']).toBe('skills-json-contract');
      expect(res.headers['content-type']).toBe('application/problem+json');
      expect(parseProblem(res.body)).toMatchObject({
        type: 'urn:ok:error:invalid-request',
        title: 'Request body is not valid JSON.',
      });
    },
  );

  test.each(SKILL_METHODS)(
    '%s preserves unsupported methods and Allow: %s',
    async (path, allow) => {
      const res = await rawRequest(server.port, path, {
        method: 'PATCH',
        headers: { 'X-Request-Id': 'skills-method-contract' },
      });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe(allow);
      expect(res.headers['content-type']).toBe('application/problem+json');
      expect(res.headers['x-request-id']).toBe('skills-method-contract');
      expect(parseProblem(res.body)).toMatchObject({
        type: 'urn:ok:error:method-not-allowed',
        status: 405,
      });
    },
  );
});
