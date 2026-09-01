import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { decodeShareUrl } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { bootEndpointServer, type EndpointRig } from './endpoint-http.test-helper.ts';
import { createGitTriangle, type GitTriangle } from './git-fixture.test-helper.ts';
import { computeShareTargetStatus } from './target-status.ts';

const triangles: GitTriangle[] = [];
function newTriangle(): GitTriangle {
  const t = createGitTriangle();
  triangles.push(t);
  return t;
}

let rig: EndpointRig | undefined;

afterEach(async () => {
  if (rig) {
    await rig.cleanup();
    rig = undefined;
  }
  for (const t of triangles.splice(0)) t.cleanup();
});

async function postTargetStatus(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/share/target-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postConstructUrl(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/share/construct-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function repointOriginAtGitHub(t: GitTriangle): void {
  t.git(t.senderDir, ['remote', 'set-url', 'origin', 'https://github.com/o/r.git']);
}

async function getBranchInfo(
  port: number,
  query: { branch: string; path: string; kind: 'doc' | 'folder' },
): Promise<Response> {
  const params = new URLSearchParams(query);
  return fetch(`http://127.0.0.1:${port}/api/git/branch-info?${params.toString()}`);
}

describe('POST /api/share/target-status (fetch through the endpoint)', () => {
  test('a recently-pushed doc the receiver ref does not know is on-origin after the endpoint fetch', async () => {
    const t = newTriangle();
    t.seedAndPush('doc1.md', 'one\n');
    const receiver = t.cloneReceiver();
    t.seedAndPush('doc2.md', 'two\n');

    rig = await bootEndpointServer({ projectDir: receiver });
    const res = await postTargetStatus(rig.port, {
      branch: t.branch,
      path: 'doc2.md',
      kind: 'doc',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'on-origin' });
  });

  test('a renamed target returns renamed with the new path carried over the wire', async () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('old.md', 'new.md');

    rig = await bootEndpointServer({ projectDir: receiver });
    const res = await postTargetStatus(rig.port, { branch: t.branch, path: 'old.md', kind: 'doc' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'renamed', renamedTo: 'new.md' });
  });

  test('a v2 rename under a nested content root returns a content-relative destination', async () => {
    const t = newTriangle();
    t.seedAndPush('wiki/old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('wiki/old.md', 'wiki/new.md');

    rig = await bootEndpointServer({ projectDir: receiver, contentDir: `${receiver}/wiki` });
    const res = await postTargetStatus(rig.port, {
      branch: t.branch,
      path: 'wiki/old.md',
      kind: 'doc',
      contentRootDepth: 1,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'renamed', renamedTo: 'new.md' });
  });

  test('a nested-root v1 rename stays repository-relative without wiki/wiki', async () => {
    const t = newTriangle();
    t.seedAndPush('wiki/old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('wiki/old.md', 'wiki/new.md');

    rig = await bootEndpointServer({ projectDir: receiver, contentDir: `${receiver}/wiki` });
    const res = await postTargetStatus(rig.port, {
      branch: t.branch,
      path: 'wiki/old.md',
      kind: 'doc',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'renamed', renamedTo: 'wiki/new.md' });
  });

  test('an unreachable origin degrades to unknown (fail-open through the endpoint)', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    t.git(receiver, ['remote', 'remove', 'origin']);

    rig = await bootEndpointServer({ projectDir: receiver });
    const res = await postTargetStatus(rig.port, { branch: t.branch, path: 'doc.md', kind: 'doc' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdict: 'unknown' });
  });
});

describe('POST /api/share/target-status path validation', () => {
  test('a traversal path is rejected with 400 before it reaches git', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    rig = await bootEndpointServer({ projectDir: receiver });

    const res = await postTargetStatus(rig.port, {
      branch: t.branch,
      path: '../etc/passwd',
      kind: 'doc',
    });

    expect(res.status).toBe(400);
  });

  test('an empty path for a doc is rejected with 400 (folder-root sentinel is folder-only)', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    rig = await bootEndpointServer({ projectDir: receiver });

    const res = await postTargetStatus(rig.port, { branch: t.branch, path: '', kind: 'doc' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/git/branch-info (shareTargetOnOriginBranch over HTTP)', () => {
  test('surfaces the network-free origin-branch probe: present is true, absent is false', async () => {
    const t = newTriangle();
    t.seedAndPush('present.md', '# here\n');
    const receiver = t.cloneReceiver();
    rig = await bootEndpointServer({ projectDir: receiver });

    const present = await getBranchInfo(rig.port, {
      branch: t.branch,
      path: 'present.md',
      kind: 'doc',
    });
    expect(present.status).toBe(200);
    expect((await present.json()).shareTargetOnOriginBranch).toBe(true);

    const absent = await getBranchInfo(rig.port, {
      branch: t.branch,
      path: 'absent.md',
      kind: 'doc',
    });
    expect(absent.status).toBe(200);
    expect((await absent.json()).shareTargetOnOriginBranch).toBe(false);
  });
});

describe('POST /api/share/construct-url (freshness computed through the endpoint)', () => {
  test('a folder holding no files reports the empty verdict on the wire', async () => {
    const t = newTriangle();
    t.mkdirWorkingTree('hollow');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({ projectDir: t.senderDir });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: 'hollow' });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      branch: t.branch,
      sharedUrl: 'https://github.com/o/r/tree/main/hollow',
      freshness: 'empty',
    });
  });

  test('a folder holding an untracked doc still reports absent — a push does fix that one', async () => {
    const t = newTriangle();
    t.writeWorkingTree('drafts/note.md', '# draft\n');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({ projectDir: t.senderDir });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: 'drafts' });

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      freshness: 'absent',
    });
  });

  test('a folder whose only contents are gitignored reports empty on the wire', async () => {
    const t = newTriangle();
    t.seedAndPush('.gitignore', 'scratch/\n');
    t.writeWorkingTree('scratch/note.md', '# ignored\n');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({ projectDir: t.senderDir });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: 'scratch' });

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      freshness: 'empty',
    });
  });
});

describe('POST /api/share/construct-url (v2 minting through the endpoint)', () => {
  function shareToken(json: Record<string, unknown>): string {
    return (json.shareUrl as string).replace('https://openknowledge.ai/d/', '');
  }

  test('a nested content root mints v2 with current freshness and the reader-decodable source', async () => {
    const t = newTriangle();
    t.seedAndPush('knowledge base/handbook/guides/getting started.md', '# Getting started\n');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({
      projectDir: t.senderDir,
      contentDir: join(t.senderDir, 'knowledge base/handbook'),
    });
    const res = await postConstructUrl(rig.port, {
      kind: 'doc',
      docPath: 'guides/getting started.md',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, freshness: 'current' });
    expect(decodeShareUrl(shareToken(json))).toEqual({
      version: 2,
      sharedUrl:
        'https://github.com/o/r/blob/main/knowledge%20base/handbook/guides/getting%20started.md',
      contentRootDepth: 2,
      source: {
        host: 'github.com',
        owner: 'o',
        repo: 'r',
        branch: 'main',
        kind: 'doc',
        targetSegments: ['knowledge base', 'handbook', 'guides', 'getting started.md'],
      },
      target: { kind: 'doc', docPath: 'guides/getting started.md' },
    });
  });

  test('a nested content root returns a business error when its origin cannot be encoded as v2', async () => {
    const t = newTriangle();
    t.seedAndPush('knowledge/doc.md', '# Document\n');
    t.git(t.senderDir, ['remote', 'set-url', 'origin', 'https://127.0.0.1/o/r.git']);

    rig = await bootEndpointServer({
      projectDir: t.senderDir,
      contentDir: join(t.senderDir, 'knowledge'),
    });
    const res = await postConstructUrl(rig.port, { kind: 'doc', docPath: 'doc.md' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: 'unsupported-share-url' });
  });

  test('the nested content-root folder share is current and decodes to the root target', async () => {
    const t = newTriangle();
    t.seedAndPush('knowledge base/handbook/guides/getting started.md', '# Getting started\n');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({
      projectDir: t.senderDir,
      contentDir: join(t.senderDir, 'knowledge base/handbook'),
    });
    const res = await postConstructUrl(rig.port, { kind: 'folder', folderPath: '' });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, freshness: 'current' });
    expect(decodeShareUrl(shareToken(json))).toEqual({
      version: 2,
      sharedUrl: 'https://github.com/o/r/tree/main/knowledge%20base/handbook',
      contentRootDepth: 2,
      source: {
        host: 'github.com',
        owner: 'o',
        repo: 'r',
        branch: 'main',
        kind: 'folder',
        targetSegments: ['knowledge base', 'handbook'],
      },
      target: { kind: 'folder', folderPath: '' },
    });
  });

  test('a repository-root content dir still mints v1 for the same pushed target', async () => {
    const t = newTriangle();
    t.seedAndPush('knowledge base/handbook/guides/getting started.md', '# Getting started\n');
    repointOriginAtGitHub(t);

    rig = await bootEndpointServer({ projectDir: t.senderDir });
    const res = await postConstructUrl(rig.port, {
      kind: 'doc',
      docPath: 'knowledge base/handbook/guides/getting started.md',
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, freshness: 'current' });
    expect(decodeShareUrl(shareToken(json))).toEqual({
      version: 1,
      sharedUrl:
        'https://github.com/o/r/blob/main/knowledge%20base/handbook/guides/getting%20started.md',
    });
  });
});

describe('target-status fetch timeout', () => {
  test('a hanging credentialed fetch is bounded by the block timeout and degrades to unknown', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();

    const sockets = new Set<Socket>();
    const blackhole = createHttpServer(() => {});
    blackhole.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', () => r()));
    const bhPort = (blackhole.address() as AddressInfo).port;
    t.git(receiver, ['remote', 'set-url', 'origin', `http://127.0.0.1:${bhPort}/repo.git`]);

    try {
      const start = performance.now();
      const status = await computeShareTargetStatus(receiver, t.branch, 'doc.md', 'doc', {
        credentialConfig: [],
        fetchTimeoutMs: 2000,
      });
      const elapsed = performance.now() - start;
      expect(status.verdict).toBe('unknown');
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => blackhole.close(() => r()));
    }
  }, 30_000);
});
