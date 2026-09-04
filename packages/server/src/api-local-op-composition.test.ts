import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

const HEARTBEAT_MS = 150;
const CHILD_BACKSTOP_MS = 15_000;

let tmpRoot: string;
let homeScratch: string;
let server: BootedServer;
let sigtermMarker: string;
let completedMarker: string;
let releaseMarker: string;

function releaseGatedDeviceFlowCli(): string[] {
  return [
    process.execPath,
    '-e',
    `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        try { fs.writeFileSync(${JSON.stringify(sigtermMarker)}, '1'); } catch (e) {}
        process.exit(0);
      });
      console.log(JSON.stringify({type:'verification', user_code:'WDJB-MJHT', verification_uri:'https://github.com/login/device', expires_in:900}));
      const started = Date.now();
      const poll = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(releaseMarker)})) {
          clearInterval(poll);
          try { fs.writeFileSync(${JSON.stringify(completedMarker)}, '1'); } catch (e) {}
          console.log(JSON.stringify({type:'complete', host:'github.com', login:'octocat'}));
          process.exit(0);
        }
        if (Date.now() - started > ${CHILD_BACKSTOP_MS}) {
          clearInterval(poll);
          process.exit(1);
        }
      }, 100);
    `,
  ];
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-local-op-native-'));
  homeScratch = realpathSync(mkdtempSync(join(homedir(), '.ok-local-op-native-')));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  sigtermMarker = join(tmpRoot, 'sigterm');
  completedMarker = join(tmpRoot, 'completed');
  releaseMarker = join(tmpRoot, 'release');
  server = await bootCompositionRig(contentDir, {
    localOpCliArgs: releaseGatedDeviceFlowCli(),
    authStreamHeartbeatMs: HEARTBEAT_MS,
  });
  await server.ready;
}, 60_000);

afterAll(async () => {
  try {
    writeFileSync(releaseMarker, '1');
  } catch {}
  try {
    await server?.destroy();
  } finally {
    await Promise.allSettled([
      rm(tmpRoot, { recursive: true, force: true }),
      rm(homeScratch, { recursive: true, force: true }),
    ]);
  }
});

describe('local-op group over the composed listener — served natively', () => {
  test('the family is registered natively (GET → 405 + Allow: POST, x-request-id echoed)', async () => {
    for (const path of [
      '/api/local-op/clone',
      '/api/local-op/ok-init',
      '/api/local-op/auth/login',
      '/api/local-op/auth/status',
      '/api/local-op/embeddings/test',
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('POST');
      expect(res.headers.get('x-request-id'), path).not.toBeNull();
    }
  });

  test('the family refuses a rebound Host with 403 over the composed listener', async () => {
    for (const path of [
      '/api/local-op/clone',
      '/api/local-op/auth/status',
      '/api/local-op/embeddings/set-key',
    ]) {
      const res = await rawRequest(server.port, path, {
        method: 'POST',
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('an unregistered namespace member answers the explicit 404 under the native leg', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/does-not-exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:not-found');
  });

  test('a POST reaches the real handler (ok-init gates on absolute-path discipline, then git-worktree shape)', async () => {
    const relative = await fetch(`http://127.0.0.1:${server.port}/api/local-op/ok-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: 'not/absolute' }),
    });
    expect(relative.status).toBe(400);
    expect(((await relative.json()) as { type?: string }).type).toBe(
      'urn:ok:error:invalid-request',
    );

    const nonGit = mkdtempSync(join(homeScratch, 'non-git-'));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/ok-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath: nonGit }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      reason: 'not-a-git-worktree',
    });
  });

  test('a forwarding header trips the proxied-request refusal on the family', async () => {
    const res = await rawRequest(server.port, '/api/local-op/some-future-op', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('auth-login streams NDJSON end-to-end: verification, heartbeat ping, disconnect-detach', async () => {
    rmSync(sigtermMarker, { force: true });
    rmSync(completedMarker, { force: true });
    rmSync(releaseMarker, { force: true });
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    if (!res.body) throw new Error('no response body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawVerification = false;
    let sawPing = false;
    while (!(sawVerification && sawPing)) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type?: string };
        if (event.type === 'verification') sawVerification = true;
        if (event.type === 'ping') sawPing = true;
      }
    }
    expect(sawVerification).toBe(true);
    expect(sawPing).toBe(true);

    expect(existsSync(completedMarker), 'child still in flight at the moment of disconnect').toBe(
      false,
    );
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      if (typeof args[0] === 'string') warns.push(args[0]);
    };
    try {
      controller.abort();
      const detachDeadline = Date.now() + 5_000;
      while (
        !warns.some((line) => line.includes('auth-stream-detached')) &&
        Date.now() < detachDeadline
      ) {
        await wait(20);
      }
      expect(
        warns.some((line) => line.includes('auth-stream-detached')),
        'server observed the disconnect as a detach before the child was released',
      ).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
    writeFileSync(releaseMarker, '1');
    const deadline = Date.now() + 10_000;
    while (!existsSync(completedMarker) && Date.now() < deadline) {
      await wait(100);
    }
    expect(existsSync(completedMarker), 'child ran to completion after disconnect').toBe(true);
    expect(existsSync(sigtermMarker), 'child was never SIGTERMed by the disconnect').toBe(false);
    rmSync(sigtermMarker, { force: true });
    rmSync(completedMarker, { force: true });
    rmSync(releaseMarker, { force: true });
  }, 20_000);

  test('chained groups still answer on one server (multi-group dispatch)', async () => {
    const syncStatus = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
    expect(syncStatus.status).toBe(200);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/local-op/auth/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});
