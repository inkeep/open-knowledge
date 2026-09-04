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

        const lock = readServerLock(resolve(projectDir, '.ok', 'local'));
        expect(lock).not.toBeNull();
        expect(lock?.port).toBe(booted.port);
        expect(lock?.url).toBe(`http://127.0.0.1:${booted.port}`);
        expect(lock?.capabilities).toContain('ui');
        expect(lock?.capabilities).toContain('http');
        expect(lock?.capabilities).toContain('ws');

        const shellRes = await fetch(`${lock?.url}/`);
        expect(shellRes.status).toBe(200);
        expect(await shellRes.text()).toContain('shell');

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
