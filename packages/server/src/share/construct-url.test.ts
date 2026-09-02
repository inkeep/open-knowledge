import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeShareUrl, ShareFreshnessSchema } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { loggerFactory, PinoLogger } from '../logger.ts';
import {
  buildGitHubBlobUrl,
  buildGitHubTreeUrl,
  emitShareConstructUrlLog,
  isValidSharePath,
} from './construct-url.ts';

interface TestRig {
  port: number;
  projectDir: string;
  server: Server;
  cleanup: () => Promise<void>;
}

async function bootRig(
  initProject?: (projectDir: string) => void,
  opts?: {
    contentDirIsRoot?: boolean;
    contentDirEscapes?: boolean;
    contentDirRelative?: string;
  },
): Promise<TestRig> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'share-construct-url-'));
  const projectDir = join(tmpRoot, 'project');
  const contentDir = opts?.contentDirEscapes
    ? join(tmpRoot, 'escaped-content')
    : opts?.contentDirIsRoot
      ? projectDir
      : join(projectDir, opts?.contentDirRelative ?? 'content');
  mkdirSync(contentDir, { recursive: true });
  initProject?.(projectDir);

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('../agent-sessions.ts');
  const { createApiExtension } = await import('../api-extension.test-helper.ts');

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

  const port = await new Promise<number>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveListen(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    port,
    projectDir,
    server,
    cleanup: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

function seedRemoteAndHead(
  projectDir: string,
  spec: { head: string; originUrl: string; branchesOnOrigin?: string[] },
): void {
  const gitDir = join(projectDir, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), spec.head);
  writeFileSync(
    join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${spec.originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  if (spec.branchesOnOrigin) {
    const refDir = join(gitDir, 'refs', 'remotes', 'origin');
    for (const branch of spec.branchesOnOrigin) {
      const refPath = join(refDir, branch);
      mkdirSync(join(refPath, '..'), { recursive: true });
      writeFileSync(refPath, 'abc123def456abc123def456abc123def456abc1\n');
    }
  }
}

async function postConstructUrl(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/share/construct-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/share/construct-url', () => {
  let rig: TestRig;

  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test('nested content dir mints a v2 document share with a content-relative target', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'docs/guide.md' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.branch).toBe('main');
    expect(json.sharedUrl).toBe(
      'https://github.com/inkeep/open-knowledge/blob/main/content/docs/guide.md',
    );
    expect(typeof json.shareUrl).toBe('string');
    expect(json.shareUrl).toMatch(/^https:\/\/openknowledge\.ai\/d\/[A-Za-z0-9_-]+$/);
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    const decoded = decodeShareUrl(encoded);
    expect(decoded).toMatchObject({
      version: 2,
      sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/content/docs/guide.md',
      contentRootDepth: 1,
      target: { kind: 'doc', docPath: 'docs/guide.md' },
    });
  });

  test('repository-root content dir keeps document shares on v1', async () => {
    rig = await bootRig(
      (projectDir) => {
        seedRemoteAndHead(projectDir, {
          head: 'ref: refs/heads/main\n',
          originUrl: 'https://github.com/inkeep/open-knowledge.git',
          branchesOnOrigin: ['main'],
        });
      },
      { contentDirIsRoot: true },
    );
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'docs/guide.md' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.sharedUrl).toBe('https://github.com/inkeep/open-knowledge/blob/main/docs/guide.md');
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    expect(decodeShareUrl(encoded)).toEqual({
      version: 1,
      sharedUrl: 'https://github.com/inkeep/open-knowledge/blob/main/docs/guide.md',
    });
  });

  test('a two-segment content dir mints content-root depth two', async () => {
    rig = await bootRig(
      (projectDir) => {
        seedRemoteAndHead(projectDir, {
          head: 'ref: refs/heads/main\n',
          originUrl: 'https://github.com/inkeep/open-knowledge.git',
          branchesOnOrigin: ['main'],
        });
      },
      { contentDirRelative: 'knowledge base/handbook' },
    );
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'start here.md' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.sharedUrl).toBe(
      'https://github.com/inkeep/open-knowledge/blob/main/knowledge%20base/handbook/start%20here.md',
    );
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    expect(decodeShareUrl(encoded)).toMatchObject({
      version: 2,
      contentRootDepth: 2,
      target: { kind: 'doc', docPath: 'start here.md' },
    });
  });

  test('no-remote: project has no origin section', async () => {
    rig = await bootRig((projectDir) => {
      const gitDir = join(projectDir, '.git');
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'a.md' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'no-remote' });
  });

  test('detached-head: HEAD is a raw SHA', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: '0123456789abcdef0123456789abcdef01234567\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'a.md' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'detached-head' });
  });

  test('branch-not-on-origin: HEAD branch has no matching remote ref', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/feature-not-pushed\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'a.md' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      ok: false,
      error: 'branch-not-on-origin',
      branch: 'feature-not-pushed',
    });
  });

  test('non-github-remote: origin is a gitlab URL', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'git@gitlab.com:inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'a.md' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'non-github-remote' });
  });

  test('GHES origins produce an enterprise-host share URL', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://ghes.acme.test/team/notes.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'a.md' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sharedUrl).toBe('https://ghes.acme.test/team/notes/blob/main/content/a.md');
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    expect(decodeShareUrl(encoded)).toMatchObject({
      version: 2,
      contentRootDepth: 1,
      target: { kind: 'doc', docPath: 'a.md' },
    });
  });

  test('invalid-path: rejects .. segment', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'docs/../etc/passwd' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'invalid-path' });
  });

  test('invalid-path: rejects .git segment', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: '.git/HEAD' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'invalid-path' });
  });

  test('invalid-path: rejects absolute path', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: '/etc/passwd' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: false, error: 'invalid-path' });
  });

  test('docPath with spaces + unicode round-trips through encode/decode', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const docPath = 'docs/Q4 OKRs — Marketing.md';
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sharedUrl).toBe(
      `https://github.com/inkeep/open-knowledge/blob/main/content/${encodeURIComponent('Q4 OKRs — Marketing.md').replace(/^/, 'docs/')}`,
    );
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    const decoded = decodeShareUrl(encoded);
    const decodedUrl = new URL(decoded.sharedUrl);
    const segments = decodedUrl.pathname.split('/');
    expect(segments.slice(0, 5)).toEqual(['', 'inkeep', 'open-knowledge', 'blob', 'main']);
    const decodedDocPath = segments
      .slice(5)
      .map((s) => decodeURIComponent(s))
      .join('/');
    expect(decodedDocPath).toBe(`content/${docPath}`);
    expect(decoded).toMatchObject({
      version: 2,
      contentRootDepth: 1,
      target: { kind: 'doc', docPath },
    });
  });

  test('happy path: branch with slash via loose ref encodes as single segment', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/feat/sharing-virality-flow\n',
        originUrl: 'git@github.com:inkeep/open-knowledge.git',
        branchesOnOrigin: ['feat/sharing-virality-flow'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'docs/guide.md' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.branch).toBe('feat/sharing-virality-flow');
    expect(json.sharedUrl).toBe(
      'https://github.com/inkeep/open-knowledge/blob/feat%2Fsharing-virality-flow/content/docs/guide.md',
    );
    const sharedUrl = new URL(json.sharedUrl as string);
    const segments = sharedUrl.pathname.split('/').filter(Boolean);
    expect(segments[2]).toBe('blob');
    expect(decodeURIComponent(segments[3])).toBe('feat/sharing-virality-flow');
  });

  test('rejects GET method with 405', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await fetch(`http://127.0.0.1:${rig.port}/api/share/construct-url`);
    expect(res.status).toBe(405);
  });

  test('rejects body without kind with 400 (discriminated union)', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, {});
    expect(res.status).toBe(400);
  });

  test('rejects bare {docPath} (no kind discriminator) with 400', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { docPath: 'a.md' });
    expect(res.status).toBe(400);
  });

  test('rejects kind-incompatible shape (doc without docPath) with 400', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', folderPath: 'docs' });
    expect(res.status).toBe(400);
  });

  test('folder kind with a path: returns encoded tree URL', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: 'docs/guides' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.branch).toBe('main');
    expect(json.sharedUrl).toBe(
      'https://github.com/inkeep/open-knowledge/tree/main/content/docs/guides',
    );
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    const decoded = decodeShareUrl(encoded);
    expect(decoded.sharedUrl).toBe(
      'https://github.com/inkeep/open-knowledge/tree/main/content/docs/guides',
    );
    expect(decoded).toMatchObject({
      version: 2,
      contentRootDepth: 1,
      target: { kind: 'folder', folderPath: 'docs/guides' },
    });
  });

  test('folder ROOT (folderPath: "") with content.dir === "." degenerates to tree/<branch>', async () => {
    rig = await bootRig(
      (projectDir) => {
        seedRemoteAndHead(projectDir, {
          head: 'ref: refs/heads/main\n',
          originUrl: 'https://github.com/inkeep/open-knowledge.git',
          branchesOnOrigin: ['main'],
        });
      },
      { contentDirIsRoot: true },
    );
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: '' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sharedUrl).toBe('https://github.com/inkeep/open-knowledge/tree/main');
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    expect(decodeShareUrl(encoded).version).toBe(1);
  });

  test('folder ROOT (folderPath: "") with content.dir subdir maps to tree/<branch>/<content.dir>', async () => {
    rig = await bootRig((projectDir) => {
      seedRemoteAndHead(projectDir, {
        head: 'ref: refs/heads/main\n',
        originUrl: 'https://github.com/inkeep/open-knowledge.git',
        branchesOnOrigin: ['main'],
      });
    });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: '' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.sharedUrl).toBe('https://github.com/inkeep/open-knowledge/tree/main/content');
    const encoded = (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
    expect(decodeShareUrl(encoded)).toMatchObject({
      version: 2,
      contentRootDepth: 1,
      target: { kind: 'folder', folderPath: '' },
    });
  });

  test('folder ROOT (folderPath: "") with contentDir escaping projectDir fails loud (500), not a repo-root link', async () => {
    rig = await bootRig(
      (projectDir) => {
        seedRemoteAndHead(projectDir, {
          head: 'ref: refs/heads/main\n',
          originUrl: 'https://github.com/inkeep/open-knowledge.git',
          branchesOnOrigin: ['main'],
        });
      },
      { contentDirEscapes: true },
    );
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: '' });
    expect(res.status).toBe(500);
  });
});

describe('buildGitHubBlobUrl branch encoding', () => {
  function extractBranchSegment(url: string): string {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[3];
  }

  function roundTripBranch(url: string): string {
    return decodeURIComponent(extractBranchSegment(url));
  }

  test('simple single-segment branch is plain text', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'main', 'README.md');
    expect(url).toBe('https://github.com/owner/repo/blob/main/README.md');
    expect(roundTripBranch(url)).toBe('main');
  });

  test('slashed branch encodes slash as %2F (single URL segment)', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'feat/foo', 'docs/page.md');
    expect(url).toBe('https://github.com/owner/repo/blob/feat%2Ffoo/docs/page.md');
    expect(extractBranchSegment(url)).toBe('feat%2Ffoo');
    expect(roundTripBranch(url)).toBe('feat/foo');
  });

  test('deeper-slash branch encodes every slash as %2F', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'release/2026-05/foo', 'a.md');
    expect(url).toBe('https://github.com/owner/repo/blob/release%2F2026-05%2Ffoo/a.md');
    expect(roundTripBranch(url)).toBe('release/2026-05/foo');
  });

  test('branch with # encodes as %23 (would otherwise be parsed as fragment)', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'feat#nest', 'a.md');
    expect(url).toBe('https://github.com/owner/repo/blob/feat%23nest/a.md');
    expect(new URL(url).hash).toBe('');
    expect(roundTripBranch(url)).toBe('feat#nest');
  });

  test('branch with space encodes as %20', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'feat space', 'a.md');
    expect(url).toBe('https://github.com/owner/repo/blob/feat%20space/a.md');
    expect(roundTripBranch(url)).toBe('feat space');
  });

  test('path segments still split on / and encoded individually (separator preserved)', () => {
    const url = buildGitHubBlobUrl('github.com', 'owner', 'repo', 'main', 'docs/sub/page name.md');
    expect(url).toBe('https://github.com/owner/repo/blob/main/docs/sub/page%20name.md');
  });

  test('docPath with unicode round-trips through per-segment encoding', () => {
    const url = buildGitHubBlobUrl(
      'github.com',
      'owner',
      'repo',
      'main',
      'docs/Q4 OKRs — Marketing.md',
    );
    const pathSegments = new URL(url).pathname.split('/').slice(5);
    expect(pathSegments.map((s) => decodeURIComponent(s)).join('/')).toBe(
      'docs/Q4 OKRs — Marketing.md',
    );
  });
});

describe('buildGitHubTreeUrl', () => {
  function extractBranchSegment(url: string): string {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments[3];
  }

  test('folder path: segments encoded individually, no trailing slash', () => {
    const url = buildGitHubTreeUrl('github.com', 'owner', 'repo', 'main', 'docs/sub folder');
    expect(url).toBe('https://github.com/owner/repo/tree/main/docs/sub%20folder');
    expect(url.endsWith('/')).toBe(false);
  });

  test('slashed branch encodes slash as %2F (single URL segment)', () => {
    const url = buildGitHubTreeUrl('github.com', 'owner', 'repo', 'feat/foo', 'docs');
    expect(url).toBe('https://github.com/owner/repo/tree/feat%2Ffoo/docs');
    expect(extractBranchSegment(url)).toBe('feat%2Ffoo');
    expect(decodeURIComponent(extractBranchSegment(url))).toBe('feat/foo');
  });

  test('empty folderPath (root) -> tree/<branch> with no trailing slash', () => {
    const url = buildGitHubTreeUrl('github.com', 'owner', 'repo', 'main', '');
    expect(url).toBe('https://github.com/owner/repo/tree/main');
    expect(url.endsWith('/')).toBe(false);
  });

  test('empty folderPath with slashed branch encodes branch, no trailing slash', () => {
    const url = buildGitHubTreeUrl('github.com', 'owner', 'repo', 'feat/foo', '');
    expect(url).toBe('https://github.com/owner/repo/tree/feat%2Ffoo');
  });
});

describe('isValidSharePath (kind-aware)', () => {
  test('empty path: valid for folder (root), invalid for doc', () => {
    expect(isValidSharePath('', 'folder')).toBe(true);
    expect(isValidSharePath('', 'doc')).toBe(false);
  });

  test('nested path: valid for both kinds', () => {
    expect(isValidSharePath('a/b', 'folder')).toBe(true);
    expect(isValidSharePath('a/b', 'doc')).toBe(true);
  });

  test('leading slash rejected for both kinds', () => {
    expect(isValidSharePath('/a/b', 'doc')).toBe(false);
    expect(isValidSharePath('/a/b', 'folder')).toBe(false);
  });

  test('leading backslash rejected', () => {
    expect(isValidSharePath('\\a', 'doc')).toBe(false);
  });

  test('.. segment rejected', () => {
    expect(isValidSharePath('docs/../etc', 'doc')).toBe(false);
    expect(isValidSharePath('docs/../etc', 'folder')).toBe(false);
  });

  test('.git segment rejected', () => {
    expect(isValidSharePath('.git/HEAD', 'doc')).toBe(false);
    expect(isValidSharePath('a/.git/b', 'folder')).toBe(false);
  });

  test('.ok and .github dot-folders allowed (gate is .git-only per D21)', () => {
    expect(isValidSharePath('.ok/config.yml', 'doc')).toBe(true);
    expect(isValidSharePath('.github/workflows', 'folder')).toBe(true);
    expect(isValidSharePath('.ok', 'folder')).toBe(true);
  });

  test('empty intermediate segment (a//b) rejected', () => {
    expect(isValidSharePath('a//b', 'doc')).toBe(false);
    expect(isValidSharePath('a//b', 'folder')).toBe(false);
  });

  test('control chars rejected for both kinds (symmetry with isValidBranchInfoPath)', () => {
    expect(isValidSharePath('a\x00b', 'doc')).toBe(false);
    expect(isValidSharePath('a\x00b', 'folder')).toBe(false);
    expect(isValidSharePath('a\tb', 'doc')).toBe(false);
    expect(isValidSharePath('a\tb', 'folder')).toBe(false);
    expect(isValidSharePath('a\x7Fb', 'doc')).toBe(false);
  });
});

describe('emitShareConstructUrlLog telemetry', () => {
  function captureLog(emit: () => void): Array<Record<string, unknown>> {
    const records: Array<Record<string, unknown>> = [];
    loggerFactory.configure({
      loggerFactory: (name: string) => {
        const logger = new PinoLogger(name, { options: { level: 'silent' } });
        logger.info = (data: unknown) => {
          records.push(data as Record<string, unknown>);
        };
        return logger;
      },
    });
    try {
      emit();
    } finally {
      loggerFactory.reset();
    }
    return records;
  }

  test('carries bounded kind attribute on success', () => {
    const records = captureLog(() =>
      emitShareConstructUrlLog('ok', { branchExists: true, kind: 'folder' }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      action: 'construct-url',
      result: 'ok',
      branchExists: true,
      kind: 'folder',
    });
  });

  test('carries kind on a business-logic failure', () => {
    const records = captureLog(() => emitShareConstructUrlLog('invalid-path', { kind: 'doc' }));
    expect(records[0]).toMatchObject({ result: 'invalid-path', kind: 'doc' });
  });

  test('records every freshness verdict distinctly, including the one no push resolves', () => {
    const verdicts = ShareFreshnessSchema.options;
    const records = captureLog(() => {
      for (const freshness of verdicts) {
        emitShareConstructUrlLog('ok', { branchExists: true, kind: 'folder', freshness });
      }
    });
    const logged = records.map((r) => r.freshness);
    expect(logged).toContain('empty');
    expect(logged).toContain('absent');
    expect(records.find((r) => r.freshness === 'empty')).toMatchObject({
      action: 'construct-url',
      result: 'ok',
      kind: 'folder',
      freshness: 'empty',
    });
    expect(new Set(logged).size).toBe(verdicts.length);
  });

  test('omits kind + branchExists when opts absent', () => {
    const records = captureLog(() => emitShareConstructUrlLog('no-remote'));
    expect(records[0]).not.toHaveProperty('kind');
    expect(records[0]).not.toHaveProperty('branchExists');
  });
});
