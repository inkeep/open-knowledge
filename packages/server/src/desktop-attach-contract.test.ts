import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { bootCompositionRig, parseProblem } from './composition-rig.test-helper.ts';
import { readServerLock } from './server-lock.ts';
import { acquireUiLock, readUiLock, releaseUiLock, updateUiLockPort } from './ui-lock.ts';

/**
 * The Claude Desktop attach contract, as it exists today. Sandboxed agent
 * panes (Claude Desktop's embedded browser) cannot be handed an arbitrary
 * URL out of band — they attach by asking the stdio MCP for a preview URL,
 * and that answer is derived entirely from `ui.lock`:
 *
 *   <projectDir>/.ok/local/ui.lock  →  http://localhost:<ui.lock.port>
 *
 * The contract the remaining readers (preview-url tools, the `--only ui`
 * split-mode collision resolver, `off-cwd-resolver`) rely on:
 *
 *   1. FIELDS — every real lock carries pid, hostname, port, startedAt,
 *      worktreeRoot, protocolVersion, runtimeVersion. The optional
 *      kind/parentPid/capabilities fields are NOT written by today's
 *      writers; nothing may start requiring them without changing writers.
 *   2. PORT SENTINEL — the lock exists with port 0 from acquire (pre-listen)
 *      until updateUiLockPort stamps the bound port. Readers must treat
 *      port 0 as "starting" (poll), never as an address.
 *   3. YIELD — a booting server that finds a live holder does not collide:
 *      it proceeds without owning the lock, leaves the peer's advertisement
 *      untouched (including on its own destroy), and emits a structured
 *      yield event.
 *   4. DISCOVERY HINT — a data server not serving the shell tells humans in
 *      its 404 body how to get the editor (restart with plain `ok start`).
 *
 * The ui.lock removal wave must keep (or deliberately re-pin) all four
 * observable behaviors and migrate every remaining reader in the same
 * release: the preview-pane flow is downstream of `ui.lock` until then, not
 * of which process serves the shell.
 */

describe('ui.lock — the Desktop attach advertisement', () => {
  test('the real writer advertises exactly the documented field set', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-fields-'));
    try {
      const projectDir = mkdtempSync(resolve(tmp, 'proj-'));
      const shellDistDir = mkdtempSync(resolve(tmp, 'dist-'));
      writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

      const booted = await bootCompositionRig(projectDir, { reactShellDistDir: shellDistDir });
      try {
        await booted.ready;
        const raw = readFileSync(resolve(projectDir, '.ok', 'local', 'ui.lock'), 'utf-8');
        const lock = JSON.parse(raw) as Record<string, unknown>;

        expect(lock.pid).toBe(process.pid);
        expect(lock.port).toBe(booted.port);
        expect(lock.hostname).toBe(hostname());
        expect(typeof lock.startedAt).toBe('string');
        expect(Number.isNaN(Date.parse(lock.startedAt as string))).toBe(false);
        expect(lock.worktreeRoot).toBe(projectDir);
        expect(typeof lock.protocolVersion).toBe('number');
        expect(typeof lock.runtimeVersion).toBe('string');

        // Optional fields the writers do not populate today. A reader that
        // starts gating on these (e.g. a desktop attach check on `kind`)
        // would silently reject every real lock.
        expect('kind' in lock).toBe(false);
        expect('parentPid' in lock).toBe(false);
        expect('capabilities' in lock).toBe(false);
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('port sentinel: acquire writes 0, updateUiLockPort stamps the bound port, release unlinks', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-sentinel-'));
    try {
      const lockDir = resolve(tmp, '.ok', 'local');
      mkdirSync(lockDir, { recursive: true });

      acquireUiLock(lockDir, { port: 0, worktreeRoot: tmp });
      expect(readUiLock(lockDir)?.port).toBe(0);

      updateUiLockPort(lockDir, 24_680);
      expect(readUiLock(lockDir)?.port).toBe(24_680);

      releaseUiLock(lockDir);
      expect(readUiLock(lockDir)).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('yield-to-live-holder emits the structured event operators grep for', async () => {
    const tmp = await mkdtemp(resolve(tmpdir(), 'ok-attach-yield-'));
    try {
      const projectDir = mkdtempSync(resolve(tmp, 'proj-'));
      const shellDistDir = mkdtempSync(resolve(tmp, 'dist-'));
      writeFileSync(resolve(shellDistDir, 'index.html'), '<html>shell</html>', 'utf-8');

      // A live peer: process.ppid is alive for the duration of the test and
      // is not process.pid (which would take the same-pid rewrite path).
      const lockDir = resolve(projectDir, '.ok', 'local');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        resolve(lockDir, 'ui.lock'),
        JSON.stringify({
          pid: process.ppid,
          hostname: hostname(),
          port: 65_432,
          startedAt: new Date().toISOString(),
          worktreeRoot: projectDir,
          protocolVersion: 1,
          runtimeVersion: '0.0.0-test-peer',
        }),
        'utf-8',
      );

      const calls: Array<Record<string, unknown>> = [];
      const capture = (obj: unknown) => {
        if (typeof obj === 'object' && obj !== null) calls.push(obj as Record<string, unknown>);
      };
      const log = {
        info: vi.fn(capture),
        warn: vi.fn(capture),
        error: vi.fn(capture),
        debug: vi.fn(capture),
        child: () => log,
      };

      const booted = await bootCompositionRig(projectDir, {
        reactShellDistDir: shellDistDir,
        log: log as never,
      });
      try {
        await booted.ready;
        const yielded = calls.find((c) => c.event === 'ui-lock-yielded-to-live-holder');
        expect(yielded).toBeDefined();
        expect(yielded?.existingPid).toBe(process.ppid);
        expect(yielded?.existingPort).toBe(65_432);
      } finally {
        await booted.destroy();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  test('a data server without the shell 404s with the no-UI restart hint', async () => {
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
 * The canonical attach contract that replaces the ui.lock flow above: a
 * server that serves the React shell advertises ONE record — `server.lock`'s
 * `url` plus `capabilities` containing `"ui"`. Claude Desktop's pre-declared
 * entrypoint (and the MCP preview tools via `resolveUiInfo`) dial that URL
 * directly; every surface (`/`, `/api/*`, `/mcp`, `/collab`) lives at the one
 * origin. The ui.lock behaviors above stay pinned for the version-skew
 * window; readers must prefer this record whenever the `ui` capability is
 * present.
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
