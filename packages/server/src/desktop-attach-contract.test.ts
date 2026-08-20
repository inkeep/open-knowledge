import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootCompositionRig, parseProblem } from './composition-rig.test-helper.ts';
import {
  acquireServerLock,
  readServerLock,
  releaseServerLock,
  updateServerLockPort,
} from './server-lock.ts';

/**
 * The Claude Desktop attach contract. Sandboxed agent panes (Claude Desktop's
 * embedded browser) cannot be handed an arbitrary URL out of band — they
 * attach by asking the stdio MCP for a preview URL, and that answer is derived
 * from `server.lock`: a shell-serving server advertises ONE record — its `url`
 * plus `capabilities` containing `"ui"`, dialed directly. (The retired
 * sibling `ui.lock` and its yield-to-live-holder flow are gone; the single
 * listener serves every surface — `/`, `/api/*`, `/mcp`, `/collab` — at that
 * one origin.)
 *
 * The contract the readers (preview-url tools, `off-cwd-resolver`, the
 * clone→open redirect) rely on:
 *
 *   1. ADVERTISEMENT — a shell-serving server.lock carries `url` +
 *      `capabilities` containing `"ui"`, and that url serves the SPA shell.
 *   2. PORT SENTINEL — the lock exists with port 0 from acquire (pre-listen)
 *      until updateServerLockPort stamps the bound port. Readers must treat
 *      port 0 as "starting" (poll), never as an address.
 *   3. DISCOVERY HINT — a data server not serving the shell (no `ui`
 *      capability) tells humans in its 404 body how to get the editor
 *      (restart with plain `ok start`).
 */

describe('server.lock — the Desktop attach advertisement', () => {
  test('port sentinel: acquire writes 0, updateServerLockPort stamps the bound port, release unlinks', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-sentinel-'));
    try {
      const lockDir = resolve(tmp, '.ok', 'local');
      mkdirSync(lockDir, { recursive: true });

      acquireServerLock(lockDir, { port: 0, worktreeRoot: tmp });
      expect(readServerLock(lockDir)?.port).toBe(0);

      updateServerLockPort(lockDir, 24_680);
      expect(readServerLock(lockDir)?.port).toBe(24_680);

      releaseServerLock(lockDir);
      expect(readServerLock(lockDir)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a data server without the shell 404s with the no-UI restart hint and omits the ui capability', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-hint-'));
    try {
      const booted = await bootCompositionRig(tmp);
      try {
        await booted.ready;
        const res = await fetch(`http://127.0.0.1:${booted.port}/`);
        expect(res.status).toBe(404);
        const body = parseProblem(await res.text());
        expect(body.detail).toContain('running without the web UI');
        expect(body.detail).toContain('ok start');
        // No shell served → server.lock advertises no `ui` capability (and no
        // separate ui.lock is ever written).
        const lock = readServerLock(resolve(tmp, '.ok', 'local'));
        expect(lock?.capabilities ?? []).not.toContain('ui');
        expect(existsSync(resolve(tmp, '.ok', 'local', 'ui.lock'))).toBe(false);
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * The canonical attach contract: a server that serves the React shell
 * advertises ONE record — `server.lock`'s `url` plus `capabilities` containing
 * `"ui"`. Claude Desktop's pre-declared entrypoint (and the MCP preview tools
 * via `resolveUiInfo`) dial that URL directly; every surface (`/`, `/api/*`,
 * `/mcp`, `/collab`) lives at the one origin.
 */
describe('server.lock v2 — the canonical Claude Desktop attach contract', () => {
  test('a shell-serving server advertises url + the ui capability, and that url serves the shell', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-v2-'));
    try {
      const projectDir = mkdtempSync(resolve(tmp, 'proj-'));
      const shellDistDir = mkdtempSync(resolve(tmp, 'dist-'));
      writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

      const booted = await bootCompositionRig(projectDir, { reactShellDistDir: shellDistDir });
      try {
        await booted.ready;

        // The advertisement: one URL, the ui capability, a bound port.
        const lock = readServerLock(resolve(projectDir, '.ok', 'local'));
        expect(lock).not.toBeNull();
        expect(lock?.port).toBe(booted.port);
        expect(lock?.url).toBe(`http://127.0.0.1:${booted.port}`);
        expect(lock?.capabilities).toContain('ui');
        expect(lock?.capabilities).toContain('http');
        expect(lock?.capabilities).toContain('ws');

        // Attach exactly as a pre-registered Desktop pane does: dial the
        // advertised URL cold and expect the SPA shell.
        const shellRes = await fetch(`${lock?.url}/`);
        expect(shellRes.status).toBe(200);
        expect(await shellRes.text()).toContain('shell');

        // Route precedence at the same origin: /api stays a data surface
        // (problem+json), never the SPA fallback.
        const apiRes = await fetch(`${lock?.url}/api/definitely-not-a-route`);
        expect(apiRes.headers.get('content-type')).toContain('json');
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('a server not serving the shell advertises no ui capability', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-v2-noui-'));
    try {
      const booted = await bootCompositionRig(tmp);
      try {
        await booted.ready;
        const lock = readServerLock(resolve(tmp, '.ok', 'local'));
        expect(lock).not.toBeNull();
        expect(lock?.capabilities).toEqual(['http', 'ws']);
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
