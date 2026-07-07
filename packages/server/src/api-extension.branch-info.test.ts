import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function bootRig(
  initProject: ((projectDir: string) => void) | null,
  options: { withoutProjectDir?: boolean } = {},
): Promise<TestRig> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'branch-info-'));
  const projectDir = join(tmpRoot, 'project');
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  initProject?.(projectDir);

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

function buildUrl(port: number, branch: string, path: string, kind?: 'doc' | 'folder'): string {
  const params = new URLSearchParams({ branch, path });
  if (kind) params.set('kind', kind);
  return `http://127.0.0.1:${port}/api/git/branch-info?${params.toString()}`;
}

async function getBranchInfo(
  port: number,
  branch: string,
  path: string,
  kind?: 'doc' | 'folder',
): Promise<Response> {
  return fetch(buildUrl(port, branch, path, kind));
}

let rig: TestRig | null = null;

afterEach(async () => {
  if (rig) {
    await rig.cleanup();
    rig = null;
  }
});

describe('GET /api/git/branch-info', () => {
  test('clean tree with file present on share branch and current branch matches', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# guide\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({
      currentBranch: 'main',
      currentHeadSha: null,
      detached: false,
      shareTargetExists: true,
      dirtyConflicts: { conflicts: false, files: [] },
      branchIsLocal: true,
    });
  });

  test('branch mismatch + file exists on current branch reports shareTargetExists=true', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# main\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'docs/guide.md', '# other\n');
      commitAll(projectDir, 'other edit');
      run(projectDir, 'git checkout -q main');
    });

    const res = await getBranchInfo(rig.port, 'other', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.currentBranch).toBe('main');
    expect(json.shareTargetExists).toBe(true);
    expect(json.branchIsLocal).toBe(true);
    expect(json.dirtyConflicts).toEqual({ conflicts: false, files: [] });
    expect(json.detached).toBe(false);
  });

  test('branch mismatch + file missing on current branch reports shareTargetExists=false', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'README.md', 'r\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'docs/only-on-other.md', '# only on other\n');
      commitAll(projectDir, 'other only');
      run(projectDir, 'git checkout -q main');
    });

    const res = await getBranchInfo(rig.port, 'other', 'docs/only-on-other.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.currentBranch).toBe('main');
    expect(json.shareTargetExists).toBe(false);
    expect(json.branchIsLocal).toBe(true);
  });

  test('dirty overlapping with branch change set reports conflict with overlap file', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a-main\n');
      write(projectDir, 'b.md', 'b-main\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b other');
      write(projectDir, 'a.md', 'a-other\n');
      commitAll(projectDir, 'other a');
      run(projectDir, 'git checkout -q main');
      write(projectDir, 'a.md', 'a-dirty\n');
      write(projectDir, 'b.md', 'b-dirty\n');
    });

    const res = await getBranchInfo(rig.port, 'other', 'a.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.dirtyConflicts).toEqual({ conflicts: true, files: ['a.md'] });
  });

  test('detached HEAD with file at HEAD reports currentBranch=null, detached=true, short SHA', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# main\n');
      commitAll(projectDir, 'init');
      const sha = run(projectDir, 'git rev-parse HEAD').trim();
      run(projectDir, 'git checkout -q -b feature');
      write(projectDir, 'feature-only.md', 'f\n');
      commitAll(projectDir, 'feature commit');
      run(projectDir, 'git checkout -q main');
      run(projectDir, `git checkout -q ${sha}`);
    });

    const res = await getBranchInfo(rig.port, 'feature', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.currentBranch).toBeNull();
    expect(json.detached).toBe(true);
    expect(typeof json.currentHeadSha).toBe('string');
    expect((json.currentHeadSha as string).length).toBe(7);
    expect(json.shareTargetExists).toBe(true);
  });

  test('branch absent locally reports branchIsLocal=false', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# main\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'never-existed-locally', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.branchIsLocal).toBe(false);
    expect(json.currentBranch).toBe('main');
    // Without a local ref, dirty-overlap can't resolve targetRef; the
    // endpoint surfaces dirtyConflicts as no-conflict in that case (no
    // change set to intersect against).
    expect(json.dirtyConflicts).toEqual({ conflicts: false, files: [] });
  });

  test('slashed branch name (feat/foo) resolves through to all fields', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# main\n');
      commitAll(projectDir, 'init');
      run(projectDir, 'git checkout -q -b feat/foo');
      write(projectDir, 'docs/guide.md', '# slashed\n');
      commitAll(projectDir, 'slashed edit');
      run(projectDir, 'git checkout -q main');
    });

    const res = await getBranchInfo(rig.port, 'feat/foo', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.currentBranch).toBe('main');
    expect(json.branchIsLocal).toBe(true);
    expect(json.shareTargetExists).toBe(true);
    expect(json.dirtyConflicts).toEqual({ conflicts: false, files: [] });
  });

  test('nested doc path resolves shareTargetExists correctly', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a/b/c/deep.md', '# deep\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'a/b/c/deep.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.shareTargetExists).toBe(true);
  });

  test('missing path query param returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await fetch(`http://127.0.0.1:${rig.port}/api/git/branch-info?branch=main`);
    expect(res.status).toBe(400);
  });

  test('missing branch query param returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await fetch(`http://127.0.0.1:${rig.port}/api/git/branch-info?path=a.md`);
    expect(res.status).toBe(400);
  });

  test('malformed branch (leading dash) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, '-evil', 'a.md');
    expect(res.status).toBe(400);
  });

  test('malformed branch (nul byte) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main injected', 'a.md');
    expect(res.status).toBe(400);
  });

  test('malformed branch (leading whitespace) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, ' main', 'a.md');
    expect(res.status).toBe(400);
  });

  test('malformed docPath (.. traversal) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'docs/../etc/passwd');
    expect(res.status).toBe(400);
  });

  test('non-git directory returns 500 with structured error envelope', async () => {
    rig = await bootRig((projectDir) => {
      // Directory exists, no git init.
      mkdirSync(projectDir, { recursive: true });
    });

    const res = await getBranchInfo(rig.port, 'main', 'a.md');
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.type).toBe('urn:ok:error:internal-server-error');
  });

  test('POST is rejected with 405', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    const res = await fetch(buildUrl(rig.port, 'main', 'a.md'), { method: 'POST' });
    expect(res.status).toBe(405);
  });

  test('kind=folder on an extant folder reports shareTargetExists=true', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guides/intro.md', '# intro\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'docs/guides', 'folder');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // `git cat-file -e <ref>:docs/guides` resolves the tree object.
    expect(json.shareTargetExists).toBe(true);
  });

  test('kind=folder on a missing folder reports shareTargetExists=false', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# guide\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'does/not/exist', 'folder');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.shareTargetExists).toBe(false);
  });

  test('kind=folder with empty path (content root) reports shareTargetExists=true (probe skipped)', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# guide\n');
      commitAll(projectDir, 'init');
    });

    // Empty path is the folder-root sentinel — the content-root tree always
    // exists, so the cat-file probe is skipped and shareTargetExists is true.
    const res = await fetch(
      `http://127.0.0.1:${rig.port}/api/git/branch-info?branch=main&path=&kind=folder`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.shareTargetExists).toBe(true);
  });

  test('empty path with kind=doc (default) returns 400', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'a.md', 'a\n');
      commitAll(projectDir, 'init');
    });

    // No `kind` -> defaults to 'doc', for which empty path is invalid.
    const res = await fetch(`http://127.0.0.1:${rig.port}/api/git/branch-info?branch=main&path=`);
    expect(res.status).toBe(400);
  });

  test('kind absent defaults to doc: behavior unchanged for a doc path', async () => {
    rig = await bootRig((projectDir) => {
      initRepo(projectDir);
      write(projectDir, 'docs/guide.md', '# guide\n');
      commitAll(projectDir, 'init');
    });

    const res = await getBranchInfo(rig.port, 'main', 'docs/guide.md');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.shareTargetExists).toBe(true);
  });
});
