import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

/**
 * Characterization: the natively-routed git group over a REAL socket through
 * the composed `bootServer` stack — native registration and the shared
 * admission posture. Gate BEHAVIOR is owned by
 * `api-admission-composition.test.ts` (path-agnostic by construction); the
 * rebound-Host pin below re-pins gate REACHABILITY for this family — a
 * native-registration bug could mount the group outside
 * `createApiRequestPipeline` without changing any happy-path response, and a
 * hostile-header probe is the only wire signal that tells those apart. The
 * wire cannot distinguish the mutating gate from the read gate (both apply
 * the same loopback + workspace-Host checks), so the mutating DECLARATION
 * itself is pinned at the table tier in `http/git-routes.test.ts`.
 *
 * The rig's content dir is not a git repository: branch-info and checkout
 * refuse on validation before any git op, and worktree-status degrades to its
 * unreadable-porcelain 200 — all real-handler responses, no git side effects.
 */

let tmpRoot: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-git-native-'));
  const contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('git group over the composed listener — served natively', () => {
  test('every route in the group is registered natively (wrong verb → 405, not a route-miss 404)', async () => {
    for (const path of ['/api/git/branch-info', '/api/git/worktree-status']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'POST' });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('GET');
    }
    const checkout = await fetch(`http://127.0.0.1:${server.port}/api/git/checkout`);
    expect(checkout.status).toBe(405);
    expect(checkout.headers.get('allow')).toBe('POST');
  });

  test('branch-info refuses missing params with its own 400 before any git op', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/git/branch-info`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
    expect(res.headers.get('x-request-id')).not.toBeNull();
  });

  test('worktree-status reaches the real handler (200 on a non-repo content dir)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/git/worktree-status`);
    expect(res.status).toBe(200);
  });

  test('checkout refuses a malformed body with its own 400 before any git op', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/git/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('checkout refuses a rebound Host with 403 (loopback/host gate survives the lift)', async () => {
    const res = await rawRequest(server.port, '/api/git/checkout', {
      method: 'POST',
      headers: { Host: 'evil.example' },
    });
    expect(res.status).toBe(403);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:host-not-allowed');
  });

  test('chained groups still answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const branchInfo = await fetch(`http://127.0.0.1:${server.port}/api/git/branch-info`);
    expect(branchInfo.status).toBe(400);
  });
});
