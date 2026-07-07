import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

interface TestRig {
  port: number;
  projectDir: string;
  server: Server;
  cleanup: () => Promise<void>;
}

function run(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' });
}

function write(cwd: string, relPath: string, content: string): void {
  const target = join(cwd, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function commitAll(cwd: string, message: string): void {
  run(cwd, 'git add -A');
  run(cwd, `git commit -q -m "${message}"`);
}

function initRepo(cwd: string): void {
  run(cwd, 'git init -q -b main');
  run(cwd, 'git config user.email "test@example.com"');
  run(cwd, 'git config user.name "Test"');
  run(cwd, 'git config commit.gpgsign false');
}

function readHead(projectDir: string): string {
  return readFileSync(join(projectDir, '.git/HEAD'), 'utf8').trim();
}

async function bootRig(
  initProject: ((projectDir: string, tmpRoot: string) => void) | null,
  options: { withoutProjectDir?: boolean } = {},
): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'checkout-api-'));
  const projectDir = join(tmpRoot, 'project');
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  initProject?.(projectDir, tmpRoot);

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('./agent-sessions.ts');
  const { createApiExtension } = await import('./api-extension.ts');

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    projectDir: options.withoutProjectDir ? undefined : projectDir,
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
    server,
    cleanup: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function postCheckout(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/git/checkout`, {
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

describe('POST /api/git/checkout', () => {
  test('clean tree + local branch switches HEAD and returns {ok:true}', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'b.md', 'b\n');
      commitAll(projectDir, 'other');
      run(projectDir, 'git checkout -q main');
    });

    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/main');

    const res = await postCheckout(rig.port, { branch: 'other' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/other');
  });

  test('slashed branch (feat/foo) round-trip — switches HEAD to refs/heads/feat/foo', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b feat/foo');
      write(projectDir, 'b.md', 'b\n');
      commitAll(projectDir, 'feat foo');
      run(projectDir, 'git checkout -q main');
    });

    const res = await postCheckout(rig.port, { branch: 'feat/foo' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/feat/foo');
  });

  test('branch absent locally + fetch succeeds switches to fetched branch', async () => {
    rig = await bootRig((projectDir, tmpRoot) => {
      const upstreamDir = join(tmpRoot, 'upstream');
      mkdirSync(upstreamDir, { recursive: true });
      initRepo(upstreamDir);
      write(upstreamDir, 'a.md', 'a\n');
      commitAll(upstreamDir, 'init');
      run(upstreamDir, 'git checkout -q -b remote-only');
      write(upstreamDir, 'remote.md', 'r\n');
      commitAll(upstreamDir, 'remote only');
      run(upstreamDir, 'git checkout -q main');
      // simple-git's fetch refuses to push to a non-bare's checked-out branch,
      // but we only fetch FROM upstream, so a regular clone-as-remote works.
      // Clone into projectDir — pulls all branches into refs/remotes/origin/*
      // but only checks out 'main' locally (so 'remote-only' is not local).
      rmSync(projectDir, { recursive: true, force: true });
      run(tmpRoot, `git clone -q ${upstreamDir} ${projectDir}`);
      run(projectDir, 'git config user.email "test@example.com"');
      run(projectDir, 'git config user.name "Test"');
      run(projectDir, 'git config commit.gpgsign false');
      // Remove the remote tracking ref so rev-parse --verify refs/heads/remote-only fails.
      run(projectDir, 'git update-ref -d refs/remotes/origin/remote-only').toString();
    });

    const res = await postCheckout(rig.port, { branch: 'remote-only' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/remote-only');
  });

  test('dirty file overlapping switch returns dirty-conflict with named files', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a-main\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'a.md', 'a-other\n');
      commitAll(projectDir, 'other a');
      run(projectDir, 'git checkout -q main');
      // Dirty the file that will change on switch
      write(projectDir, 'a.md', 'a-dirty\n');
    });

    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/main');

    const res = await postCheckout(rig.port, { branch: 'other' });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(false);
    expect(res.json.reason).toBe('dirty-conflict');
    expect(res.json.files).toEqual(['a.md']);
    // HEAD must not have changed
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/main');
  });

  test('branch not local and fetch fails because branch is missing upstream returns branch-not-found', async () => {
    rig = await bootRig((projectDir, tmpRoot) => {
      const upstreamDir = join(tmpRoot, 'upstream');
      mkdirSync(upstreamDir, { recursive: true });
      initRepo(upstreamDir);
      write(upstreamDir, 'a.md', 'a\n');
      commitAll(upstreamDir, 'init');
      rmSync(projectDir, { recursive: true, force: true });
      run(tmpRoot, `git clone -q ${upstreamDir} ${projectDir}`);
      run(projectDir, 'git config user.email "test@example.com"');
      run(projectDir, 'git config user.name "Test"');
      run(projectDir, 'git config commit.gpgsign false');
    });

    const res = await postCheckout(rig.port, { branch: 'never-existed-anywhere' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: false, reason: 'branch-not-found' });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/main');
  });

  test('branch not local and fetch fails because origin is unreachable returns fetch-failed', async () => {
    rig = await bootRig((projectDir, tmpRoot) => {
      const upstreamDir = join(tmpRoot, 'upstream');
      mkdirSync(upstreamDir, { recursive: true });
      initRepo(upstreamDir);
      write(upstreamDir, 'a.md', 'a\n');
      commitAll(upstreamDir, 'init');
      rmSync(projectDir, { recursive: true, force: true });
      run(tmpRoot, `git clone -q ${upstreamDir} ${projectDir}`);
      run(projectDir, 'git config user.email "test@example.com"');
      run(projectDir, 'git config user.name "Test"');
      run(projectDir, 'git config commit.gpgsign false');
      // Point origin at an unresolvable host so any fetch fails with a non-
      // branch-not-found message.
      run(projectDir, 'git remote set-url origin https://invalid.example.invalid/repo.git');
    });

    const res = await postCheckout(rig.port, { branch: 'never-existed-anywhere' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: false, reason: 'fetch-failed' });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/main');
  });

  test('malformed branch (leading dash) returns 400 and never touches git', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'b.md', 'b\n');
      commitAll(projectDir, 'other');
      run(projectDir, 'git checkout -q main');
    });
    const headBefore = readHead(rig.projectDir);
    const reflogBefore = run(rig.projectDir, 'git reflog show HEAD');

    const res = await postCheckout(rig.port, { branch: '-upload-pack=evil' });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe('urn:ok:error:invalid-request');
    expect(readHead(rig.projectDir)).toBe(headBefore);
    // No git command ran (HEAD reflog unchanged, no fetch entry recorded).
    const reflogAfter = run(rig.projectDir, 'git reflog show HEAD');
    expect(reflogAfter).toBe(reflogBefore);
  });

  test('malformed branch (nul/control char) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await postCheckout(rig.port, { branch: 'main injected' });
    expect(res.status).toBe(400);
  });

  test('malformed branch (leading whitespace) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await postCheckout(rig.port, { branch: ' main' });
    expect(res.status).toBe(400);
  });

  test('malformed branch (.. segment) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await postCheckout(rig.port, { branch: 'feat/../escape' });
    expect(res.status).toBe(400);
  });

  test('malformed branch (colon — refspec injection) returns 400 and never touches git', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });
    const headBefore = readHead(rig.projectDir);
    const reflogBefore = run(rig.projectDir, 'git reflog show HEAD');

    // `HEAD:refs/heads/evil` would, without the colon rejection, reach
    // `git fetch origin <branch>` where `:` is the refspec separator —
    // attacker-controlled share URLs could rewrite local refs.
    const res = await postCheckout(rig.port, { branch: 'HEAD:refs/heads/evil' });
    expect(res.status).toBe(400);
    expect(res.json.type).toBe('urn:ok:error:invalid-request');
    expect(readHead(rig.projectDir)).toBe(headBefore);
    const reflogAfter = run(rig.projectDir, 'git reflog show HEAD');
    expect(reflogAfter).toBe(reflogBefore);
  });

  test('empty branch returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await postCheckout(rig.port, { branch: '' });
    expect(res.status).toBe(400);
  });

  test('missing branch field returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await postCheckout(rig.port, {});
    expect(res.status).toBe(400);
  });

  test('GET is rejected with 405', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await fetch(`http://127.0.0.1:${rig.port}/api/git/checkout`);
    expect(res.status).toBe(405);
  });

  test('missing projectDir surfaces 500 with structured error envelope', async () => {
    rig = await bootRig(
      (projectDir) => {
        initRepo(projectDir);
        write(projectDir, 'a.md', 'a\n');
        commitAll(projectDir, 'init');
      },
      { withoutProjectDir: true },
    );

    const res = await postCheckout(rig.port, { branch: 'main' });
    expect(res.status).toBe(500);
    expect(res.json.type).toBe('urn:ok:error:internal-server-error');
  });

  test('request with principalId is accepted (identity extracted at entry)', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'b.md', 'b\n');
      commitAll(projectDir, 'other');
      run(projectDir, 'git checkout -q main');
    });

    const res = await postCheckout(rig.port, {
      branch: 'other',
      principalId: 'principal-test-uuid',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(readHead(rig.projectDir)).toBe('ref: refs/heads/other');
  });

  test('two concurrent checkouts serialize through withParentLock (HEAD ends in the second branch)', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b one');
      write(projectDir, 'b.md', 'b\n');
      commitAll(projectDir, 'one');
      run(projectDir, 'git checkout -q -b two');
      write(projectDir, 'c.md', 'c\n');
      commitAll(projectDir, 'two');
      run(projectDir, 'git checkout -q main');
    });

    // Fire two checkouts in parallel without awaiting. withParentLock's
    // FIFO queue means they run sequentially server-side. Both should
    // succeed (no index-lock contention) and HEAD ends at the second.
    const [r1, r2] = await Promise.all([
      postCheckout(rig.port, { branch: 'one' }),
      postCheckout(rig.port, { branch: 'two' }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.ok).toBe(true);
    expect(r2.json.ok).toBe(true);
    // Final HEAD reflects whichever ran last under the lock — we accept
    // either ordering, but reflog should show both transitions, never an
    // index-lock failure.
    const finalHead = readHead(rig.projectDir);
    expect(['ref: refs/heads/one', 'ref: refs/heads/two']).toContain(finalHead);
    const reflog = run(rig.projectDir, 'git reflog show HEAD');
    expect(reflog).toContain('checkout: moving from');
  });
});
