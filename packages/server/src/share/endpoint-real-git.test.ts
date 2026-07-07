/**
 * The first tests in the repo that drive a git fetch THROUGH an HTTP endpoint:
 * construct-url's real-HTTP boot harness composed with the real-git triangle
 * fixture. `POST /api/share/target-status` and `GET /api/git/branch-info` run
 * their actual fetch + remote-tracking-ref probes against a receiver clone, so
 * the endpoint wiring (routing, request validation, content-relative path
 * mapping, response serialization) is exercised at production fidelity rather
 * than mocked. All local (bare origin on the same filesystem) — no network, so
 * they run unskipped in the default test tier.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
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
    // Pushed AFTER the clone: the receiver's origin ref is stale and does not
    // know doc2 yet. Only the endpoint's own fetch can reveal it — without the
    // fetch this would classify as never-on-branch.
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
    // renamedTo survives the discriminated-union response serialization.
    expect(await res.json()).toEqual({ verdict: 'renamed', renamedTo: 'new.md' });
  });

  test('an unreachable origin degrades to unknown (fail-open through the endpoint)', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    // No reachable origin — the endpoint's fetch fails fast and the handler
    // falls open to today's guidance rather than 500ing the miss surface.
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

    // Malformed paths are refused at the handler boundary (parity with the
    // sibling share handlers) — a degraded verdict is never computed for them.
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

describe('target-status fetch timeout', () => {
  test('a hanging credentialed fetch is bounded by the block timeout and degrades to unknown', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();

    // A black-hole HTTP origin accepts git's info/refs request and never
    // responds, so the fetch hangs with no output — exactly the stall the block
    // timeout exists to bound. The endpoint handler hardcodes the 15s default,
    // so the timeout knob is exercised here at the compute layer; the handler's
    // fail-open catch is covered by the offline test above.
    const sockets = new Set<Socket>();
    const blackhole = createHttpServer(() => {
      // intentionally never responds
    });
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
        fetchTimeoutMs: 2000,
      });
      const elapsed = performance.now() - start;
      expect(status.verdict).toBe('unknown');
      // The band proves the timeout actually engaged rather than the test being
      // an offline fast-fail in disguise: git hung on the black hole for roughly
      // the injected budget (lower bound), and the injected budget — not the 15s
      // default — is what released it (upper bound).
      expect(elapsed).toBeGreaterThanOrEqual(1500);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => blackhole.close(() => r()));
    }
  }, 30_000);
});
