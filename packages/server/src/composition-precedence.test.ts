import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem } from './composition-rig.test-helper.ts';

/**
 * Characterization: cross-surface route precedence, readiness, and shutdown
 * as observed over the composed `bootServer` listener. The existing shell
 * end-to-end test pins shell/content/API precedence; this suite pins the
 * surfaces that had no composed-rig coverage — /mcp vs /api vs static
 * discrimination, exact-match quirks (trailing slash, case), 405 method
 * dispatch, mode-differential 404 bodies, readiness as seen from a socket,
 * and teardown draining a live collab WebSocket.
 */

let tmpRoot: string;
let normal: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-precedence-'));
  const normalDir = mkdtempSync(resolve(tmpRoot, 'normal-'));
  normal = await bootCompositionRig(normalDir);
  await normal.ready;
}, 60_000);

afterAll(async () => {
  await normal?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('route dispatch and precedence — normal mode (no React shell)', () => {
  test('known API route answers JSON on the composed port', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/server-info`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('unknown /api path 404s from the API dispatcher, with the API-specific body', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const body = parseProblem(await res.text());
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('API endpoint not found.');
  });

  test('route matching is exact: a trailing slash misses the route table', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/server-info/`);
    expect(res.status).toBe(404);
    const body = parseProblem(await res.text());
    expect(body.title).toBe('API endpoint not found.');
  });

  test('route matching is case-sensitive: /API/* is not API traffic and falls to static 404', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/API/server-info`);
    expect(res.status).toBe(404);
    const body = parseProblem(await res.text());
    expect(body.title).toBe('Not found.');
  });

  test('unknown non-API path 404s with the ok-ui hint when no shell is mounted', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/definitely/not/here`);
    expect(res.status).toBe(404);
    const body = parseProblem(await res.text());
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.detail).toContain('ok ui');
  });

  test('/mcp is mounted at the exact path only', async () => {
    const exact = await fetch(`http://127.0.0.1:${normal.port}/mcp`, { method: 'OPTIONS' });
    expect(exact.status).toBe(204);

    const slash = await fetch(`http://127.0.0.1:${normal.port}/mcp/`, { method: 'OPTIONS' });
    expect(slash.status).toBe(404);
  });

  test('wrong method on a declared-method route yields 405 with an Allow header, before body read', async () => {
    const res = await fetch(`http://127.0.0.1:${normal.port}/api/create-page`, {
      method: 'GET',
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    const body = parseProblem(await res.text());
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
  });

  test('a live /collab WebSocket connects through the composed upgrade path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${normal.port}/collab`);
    await new Promise<void>((resolvePromise, reject) => {
      ws.on('open', () => resolvePromise());
      ws.on('error', reject);
    });
    ws.close();
    await new Promise<void>((resolvePromise) => ws.on('close', () => resolvePromise()));
  });
});

describe('desktop-shape composition (React shell mounted)', () => {
  let desktop: BootedServer;
  let desktopTmp: string;

  beforeAll(async () => {
    desktopTmp = await mkdtemp(resolve(tmpdir(), 'ok-precedence-desktop-'));
    const projectDir = mkdtempSync(resolve(desktopTmp, 'proj-'));
    const shellDistDir = mkdtempSync(resolve(desktopTmp, 'dist-'));
    writeFileSync(
      resolve(shellDistDir, 'index.html'),
      '<!DOCTYPE html><html><body data-test="shell">ok</body></html>',
      'utf-8',
    );
    desktop = await bootCompositionRig(projectDir, {
      reactShellDistDir: shellDistDir,
      serveContentAssets: true,
    });
    await desktop.ready;
  }, 60_000);

  afterAll(async () => {
    await desktop?.destroy();
    await rm(desktopTmp, { recursive: true, force: true });
  });

  test('SPA fallback does not shadow /mcp or /api', async () => {
    const deep = await fetch(`http://127.0.0.1:${desktop.port}/some/deep/route`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('data-test="shell"');

    const mcp = await fetch(`http://127.0.0.1:${desktop.port}/mcp`, { method: 'OPTIONS' });
    expect(mcp.status).toBe(204);

    const api = await fetch(`http://127.0.0.1:${desktop.port}/api/definitely-not-a-route`);
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toBe('application/problem+json');
  });
});

describe('readiness and shutdown over the composed listener', () => {
  test('a document-list request racing async init never sees a false-empty index', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-ready-race-'));
    try {
      mkdirSync(resolve(tmp, 'docs'), { recursive: true });
      writeFileSync(resolve(tmp, 'docs', 'seeded-note.md'), '# seeded\n', 'utf-8');
      const booted = await bootCompositionRig(tmp);
      try {
        // Deliberately no `await booted.ready` — the request must park on
        // readiness server-side rather than answer from a half-built index.
        // Bounded abort so a genuine readiness hang reads as an abort, not
        // an indistinguishable test-runner timeout.
        const res = await fetch(`http://127.0.0.1:${booted.port}/api/documents`, {
          signal: AbortSignal.timeout(75_000),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('seeded-note');
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    // 90s: this test pays for a full boot; under whole-suite CPU saturation
    // the boot alone has been observed to exceed 30s on a loaded runner.
  }, 90_000);

  test('destroy() drains a live collab WebSocket, closes the listener, and marks server.lock draining', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-shutdown-'));
    try {
      const booted = await bootCompositionRig(tmp);
      await booted.ready;

      const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/collab`);
      await new Promise<void>((resolvePromise, reject) => {
        ws.on('open', () => resolvePromise());
        ws.on('error', reject);
      });

      const wsClosed = new Promise<void>((resolvePromise) =>
        ws.on('close', () => resolvePromise()),
      );

      const lockPath = resolve(booted.lockDir, 'server.lock');
      expect(existsSync(lockPath)).toBe(true);

      await booted.destroy();

      await wsClosed;
      expect(booted.httpServer.listening).toBe(false);
      // The lock is NOT unlinked by in-process destroy(): release marks it
      // draining and defers the unlink to process exit, so discovery stops
      // dialing immediately while crash-vs-clean-exit stays distinguishable
      // on disk. Only process exit removes the file (pinned by the CLI e2e's
      // SIGTERM case).
      expect(existsSync(lockPath)).toBe(true);
      const lock = JSON.parse(readFileSync(lockPath, 'utf-8')) as { draining?: boolean };
      expect(lock.draining).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
