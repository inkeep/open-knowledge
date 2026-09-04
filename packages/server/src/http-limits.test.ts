import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

let tmpRoot: string;
let booted: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-http-limits-'));
  const dir = mkdtempSync(resolve(tmpRoot, 'proj-'));
  booted = await bootCompositionRig(dir);
  await booted.ready;
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('request body size cap', () => {
  test('a JSON body over 1 MiB is refused with 413 payload-too-large', async () => {
    const oversized = `{"docName":"a","content":"${'x'.repeat(1_048_576)}"}`;
    const res = await rawRequest(booted.port, '/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:payload-too-large');
    expect(body.title).toBe('Payload too large.');
  });

  test('a body under the cap is read in full and fails on schema, not size', async () => {
    const underCap = `{"unexpected":"${'x'.repeat(64 * 1024)}"}`;
    const res = await rawRequest(booted.port, '/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: underCap,
    });
    expect(res.status).toBe(400);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });

  test('a syntactically invalid JSON body is a 400, not a 500', async () => {
    const res = await rawRequest(booted.port, '/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:invalid-request');
  });
});

describe('server-level timeout knobs', () => {
  test('slow-client protections are pinned on the composed listener', async () => {
    expect(booted.httpServer.headersTimeout).toBe(30_000);
    expect(booted.httpServer.requestTimeout).toBe(60_000);
  });
});
