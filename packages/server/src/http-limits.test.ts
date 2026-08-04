import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: HTTP request-size and timeout protections as observed
 * over the composed listener. The JSON body cap and the slowloris body
 * timeout live in the shared `withValidation` read path; before this suite
 * neither had any test at any layer. The body-read timeout (30 s) is too
 * slow to exercise for real in a unit run, so this suite pins the
 * server-level timeout knobs structurally and leaves live 408 timing to a
 * future injectable-clock change if flake-free timing ever matters.
 */

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
    // Barely over the cap on purpose. The refusal path responds 413 and then
    // destroys the socket WITHOUT draining unread request bytes, so a client
    // still uploading a grossly oversized body can get a TCP reset before it
    // reads the 413 (kernel-buffer race; reproduced under parallel-suite
    // load with a 2 MiB body). Just-over-cap means the server consumes
    // essentially the whole body before refusing, making the 413 readable
    // deterministically. The lost-413-on-big-uploads wart is part of the
    // characterized behavior.
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
    // Structural pin: these are the boot-time knobs that bound the header
    // and whole-request phases. If either changes, deployment guidance and
    // reverse-proxy buffering advice must be revisited alongside it.
    expect(booted.httpServer.headersTimeout).toBe(30_000);
    expect(booted.httpServer.requestTimeout).toBe(60_000);
  });
});
