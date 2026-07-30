import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface TestConcurrencyGuard {
  tryAcquire(key: string): boolean;
  release(key: string): void;
}

interface TestRig {
  port: number;
  projectDir: string;
  tmpRoot: string;
  server: Server;
  cleanup: () => Promise<void>;
}

function run(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' });
}

function initRepo(cwd: string): void {
  run(cwd, 'git init -q -b main');
  run(cwd, 'git config user.email "test@example.com"');
  run(cwd, 'git config user.name "Test"');
  run(cwd, 'git config commit.gpgsign false');
}

/**
 * Boot a Hocuspocus-based api-extension test rig. The rig's projectDir is
 * what `createApiExtension({projectDir})` receives; the ok-init endpoint
 * doesn't read from it (the body's projectPath is the operative target),
 * so a minimal git repo there satisfies the boot.
 */
async function bootRig(
  options: { localOpConcurrencyGuard?: TestConcurrencyGuard } = {},
): Promise<TestRig> {
  // Root tmpRoot under the real home dir so projectPaths constructed beneath
  // it pass the handler's `isSafeLocalPath` home-dir containment gate. (A
  // tmpdir() root resolves outside $HOME on macOS — `/private/var/...` — and
  // would be rejected with `dir-outside-home`.) realpath-collapse so target
  // paths match what the handler returns (canonical realpath).
  const tmpRoot = realpathSync(mkdtempSync(join(homedir(), '.ok-init-api-test-')));
  const projectDir = join(tmpRoot, 'host-project');
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  initRepo(projectDir);
  writeFileSync(join(projectDir, 'README.md'), '# host\n');
  run(projectDir, 'git add -A');
  run(projectDir, 'git commit -q -m initial');

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('./agent-sessions.ts');
  const { createApiExtension } = await import('./api-extension.test-helper.ts');

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    projectDir,
    getFileIndex: () => new Map(),
    serverInstanceId: 'test-instance',
    localOpConcurrencyGuard: options.localOpConcurrencyGuard,
  });

  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    // biome-ignore lint/suspicious/noExplicitAny: test harness
    hocuspocus.hooks('onRequest', { request: req, response: res } as any).catch(() => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end('Error');
      }
    });
  });
  hocuspocus.configuration.extensions.push(ext);

  const { port } = await listenOnLoopback(server);

  return {
    port,
    projectDir,
    tmpRoot,
    server,
    cleanup: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function postOkInit(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown>; retryAfter: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/local-op/ok-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test
  const json = (await res.json()) as any;
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}

let rig: TestRig | null = null;

afterEach(async () => {
  if (rig) {
    await rig.cleanup();
    rig = null;
  }
});

describe('POST /api/local-op/ok-init', () => {
  test('scaffolds .ok/config.yml on a fresh git worktree → {ok:true}', async () => {
    rig = await bootRig();
    const target = join(rig.tmpRoot, 'fresh-worktree');
    mkdirSync(target);
    initRepo(target);
    writeFileSync(join(target, 'README.md'), '# fresh\n');
    run(target, 'git add -A');
    run(target, 'git commit -q -m initial');

    expect(existsSync(join(target, '.ok'))).toBe(false);

    const res = await postOkInit(rig.port, { projectPath: target });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.projectPath).toBe(target);
    expect(existsSync(join(target, '.ok/config.yml'))).toBe(true);
    expect(existsSync(join(target, '.ok/.gitignore'))).toBe(true);
    expect(existsSync(join(target, '.okignore'))).toBe(true);
  });

  test('idempotent: re-call on already-initialized project returns {ok:true} without rewriting config.yml', async () => {
    rig = await bootRig();
    const target = join(rig.tmpRoot, 'existing');
    mkdirSync(target);
    initRepo(target);
    writeFileSync(join(target, 'README.md'), '# x\n');
    run(target, 'git add -A');
    run(target, 'git commit -q -m initial');

    // First call scaffolds.
    const first = await postOkInit(rig.port, { projectPath: target });
    expect(first.json.ok).toBe(true);

    // Customize config.yml.
    const configPath = join(target, '.ok/config.yml');
    writeFileSync(configPath, 'custom: true\n');

    // Second call should NOT rewrite.
    const second = await postOkInit(rig.port, { projectPath: target });
    expect(second.json.ok).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe('custom: true\n');
  });

  test('non-git path returns {ok:false, reason:"not-a-git-worktree"}', async () => {
    rig = await bootRig();
    const target = join(rig.tmpRoot, 'not-a-repo');
    mkdirSync(target);

    const res = await postOkInit(rig.port, { projectPath: target });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.reason).toBe('not-a-git-worktree');
    // No .ok/ written.
    expect(existsSync(join(target, '.ok'))).toBe(false);
  });

  test('non-existent path returns {ok:false, reason:"not-a-git-worktree"}', async () => {
    rig = await bootRig();
    const target = join(rig.tmpRoot, 'does-not-exist');

    const res = await postOkInit(rig.port, { projectPath: target });
    expect(res.json.ok).toBe(false);
    expect(res.json.reason).toBe('not-a-git-worktree');
  });

  test('projectPath outside home returns 400 (urn:ok:error:dir-outside-home) without scaffolding', async () => {
    rig = await bootRig();
    // A real, existing git worktree rooted OUTSIDE the user home dir
    // (tmpdir resolves to /private/var/... on macOS — outside $HOME). The
    // path must exist so `realpathSync` succeeds and execution reaches the
    // containment gate rather than short-circuiting on not-a-git-worktree.
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-init-outside-home-')));
    try {
      mkdirSync(join(outsideRoot, 'repo'));
      const target = join(outsideRoot, 'repo');
      initRepo(target);
      writeFileSync(join(target, 'README.md'), '# outside\n');
      run(target, 'git add -A');
      run(target, 'git commit -q -m initial');

      const res = await postOkInit(rig.port, { projectPath: target });
      expect(res.status).toBe(400);
      expect(res.json.type).toBe('urn:ok:error:dir-outside-home');
      // The containment gate fires before `initContent` — no scaffold written.
      expect(existsSync(join(target, '.ok'))).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test('relative path returns 400 problem+json (urn:ok:error:invalid-request)', async () => {
    rig = await bootRig();
    const res = await postOkInit(rig.port, { projectPath: 'relative/path' });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe('urn:ok:error:invalid-request');
  });

  test('returns 429 on contention and releases the guard after init failure', async () => {
    const key = '/api/local-op/ok-init';
    const acquired: string[] = [];
    const released: string[] = [];
    let rejectAcquisition = true;
    let held = false;
    const guard: TestConcurrencyGuard = {
      tryAcquire(nextKey) {
        acquired.push(nextKey);
        if (rejectAcquisition || held) return false;
        held = true;
        return true;
      },
      release(nextKey) {
        released.push(nextKey);
        held = false;
      },
    };
    rig = await bootRig({ localOpConcurrencyGuard: guard });
    const target = join(rig.tmpRoot, 'guarded-worktree');
    mkdirSync(target);
    initRepo(target);
    writeFileSync(join(target, 'README.md'), '# guarded\n');
    run(target, 'git add -A');
    run(target, 'git commit -q -m initial');

    const contended = await postOkInit(rig.port, { projectPath: target });
    expect(contended.status).toBe(429);
    expect(contended.json.type).toBe('urn:ok:error:concurrent-operation');
    expect(contended.retryAfter).toBe('2');
    expect(acquired).toEqual([key]);
    expect(released).toEqual([]);

    rejectAcquisition = false;
    writeFileSync(join(target, '.ok'), 'blocks scaffold directory\n');
    const failed = await postOkInit(rig.port, { projectPath: target });
    expect(failed.status).toBe(200);
    expect(failed.json).toMatchObject({ ok: false, reason: 'init-failed' });
    expect(acquired).toEqual([key, key]);
    expect(released).toEqual([key]);
    expect(held).toBe(false);
  });

  test('scaffolds inside a linked worktree (FR13 + D12 spirit)', async () => {
    rig = await bootRig();
    const main = join(rig.tmpRoot, 'main-repo');
    mkdirSync(main);
    initRepo(main);
    writeFileSync(join(main, 'README.md'), '# main\n');
    run(main, 'git add -A');
    run(main, 'git commit -q -m initial');
    const wt = join(rig.tmpRoot, 'wt-feat');
    run(main, `git worktree add -b feat ${wt}`);

    const res = await postOkInit(rig.port, { projectPath: wt });
    expect(res.json.ok).toBe(true);
    expect(existsSync(join(wt, '.ok/config.yml'))).toBe(true);
    // The linked worktree's .git is a pointer file, not a directory — our
    // gate accepts both 'directory' and 'linked' kinds.
  });
});
