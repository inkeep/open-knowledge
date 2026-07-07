import { afterEach, describe, expect, test } from 'bun:test';
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
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

/**
 * Locate the source body that follows `const <handlerNameConst> = '...'`
 * declaration and return the next ~80 lines as a single string. The
 * 429-emission test uses this to scope a `.toContain` check to the
 * ok-init handler block without false-matching the same URN/header in
 * unrelated handlers.
 */
function extractHandlerBlock(src: string, handlerNameConst: string): string {
  const anchorRe = new RegExp(`const\\s+${handlerNameConst}\\s*=`);
  const match = anchorRe.exec(src);
  if (!match) {
    throw new Error(`extractHandlerBlock: '${handlerNameConst}' anchor not found`);
  }
  // 80 lines × roughly 80 chars = ~6400 chars. Generous slice to catch
  // both the tryAcquire branch and the finally-release.
  return src.slice(match.index, match.index + 6400);
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
async function bootRig(): Promise<TestRig> {
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
  const { createApiExtension } = await import('./api-extension.ts');

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    projectDir,
    getFileIndex: () => new Map(),
    serverInstanceId: 'test-instance',
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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/local-op/ok-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: test
  const json = (await res.json()) as any;
  return { status: res.status, json };
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

  test('429 problem+json contract — handler is wired through localOpGuard with the ok-init key', () => {
    // The localOpGuard-backed 429 path is the user-facing contract when
    // a concurrent ok-init lands while one is in-flight. The race itself
    // is hard to observe deterministically through node:http's serial
    // request dispatch (the synchronous initContent + finally{release}
    // window is shorter than the body-parse + sync-gates window of the
    // next request in the rig), so we validate the contract via source
    // scan instead — three invariants the handler MUST satisfy:
    //
    //   1. A dedicated key constant `LOCAL_OP_OK_INIT_KEY` is declared
    //      with the canonical channel string `/api/local-op/ok-init`.
    //   2. The handler acquires the key via `localOpGuard.tryAcquire`
    //      and emits a 429 with `urn:ok:error:concurrent-operation`
    //      and the `Retry-After: 2` header on contention.
    //   3. The key is released in a `finally` block so a thrown
    //      `withParentLock` task can't leak the lock.
    //
    // Source scanning here is in the spirit of the structural-ratchet
    // pattern (`ipc-channel-count-ratchet.test.ts`, `no-loosely-typed-
    // webcontents-ipc.test.ts`): a regression that removes the lock or
    // the 429 envelope shape would silently re-enable the race the
    // guard exists to prevent.
    const apiExtensionSrc = readFileSync(join(__dirname, 'api-extension.ts'), 'utf8');

    // (1) Key constant declared with the canonical channel string.
    expect(apiExtensionSrc).toMatch(/LOCAL_OP_OK_INIT_KEY\s*=\s*['"]\/api\/local-op\/ok-init['"]/);

    // (2a) Handler calls tryAcquire on the key.
    expect(apiExtensionSrc).toMatch(/localOpGuard\.tryAcquire\(LOCAL_OP_OK_INIT_KEY\)/);

    // (2b) 429 + concurrent-operation URN + Retry-After header live in
    // the handler block immediately following the tryAcquire negative
    // branch. Co-located so a regression that breaks the contract
    // surfaces here.
    const okInitBlock = extractHandlerBlock(apiExtensionSrc, 'HANDLE_LOCAL_OP_OK_INIT');
    expect(okInitBlock).toContain('429');
    expect(okInitBlock).toContain("'urn:ok:error:concurrent-operation'");
    expect(okInitBlock).toContain("'Retry-After'");

    // (3) Release lives in a finally block (catches both happy-path
    // success and `withParentLock` throws).
    expect(okInitBlock).toMatch(/finally\s*\{[^}]*localOpGuard\.release\(LOCAL_OP_OK_INIT_KEY\)/s);
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
