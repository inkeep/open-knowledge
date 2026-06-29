
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnLoopback } from '../loopback-rig-test-helpers.ts';
import type { SyncEngine } from '../sync-engine.ts';

function makeFakeSyncEngine(): { engine: SyncEngine; refreshRemoteCalls: () => number } {
  let calls = 0;
  const engine = {
    refreshRemote: async () => {
      calls += 1;
    },
  };
  return {
    engine: engine as unknown as SyncEngine,
    refreshRemoteCalls: () => calls,
  };
}

interface TestRig {
  port: number;
  baseUrl: string;
  projectDir: string;
  server: Server;
  cleanup: () => Promise<void>;
}

function fixtureCliArgs(eventLine: string): readonly string[] {
  const safe = eventLine.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return [process.execPath, '-e', `process.stdout.write(\`${safe}\\n\`);`];
}

interface RigOptions {
  cliArgs: readonly string[];
  withProjectDir?: boolean;
  getSyncEngine?: () => SyncEngine | null;
}

async function bootRig(options: RigOptions): Promise<TestRig> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'share-publish-int-'));
  const projectDir = join(tmpRoot, 'project');
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  const { Hocuspocus } = await import('@hocuspocus/server');
  const { AgentSessionManager } = await import('../agent-sessions.ts');
  const { createApiExtension } = await import('../api-extension.ts');

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    projectDir: options.withProjectDir === false ? undefined : projectDir,
    getFileIndex: () => new Map(),
    serverInstanceId: 'test-instance',
    localOpCliArgs: [...options.cliArgs],
    ...(options.getSyncEngine ? { getSyncEngine: options.getSyncEngine } : {}),
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

  const { port, baseUrl } = await listenOnLoopback(server);

  return {
    port,
    baseUrl,
    projectDir,
    server,
    cleanup: async () => {
      await new Promise<void>((res) => server.close(() => res()));
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}


describe('GET /api/share/publish/owners', () => {
  let rig: TestRig;
  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test('happy path: owners payload round-trips into ok:true body', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(
        JSON.stringify({
          type: 'owners',
          owners: [
            { login: 'alice', kind: 'user', avatarUrl: 'a' },
            { login: 'inkeep', kind: 'org' },
          ],
        }),
      ),
    });
    const { status, body } = await getJson(rig.port, '/api/share/publish/owners');
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      owners: [
        { login: 'alice', kind: 'user', avatarUrl: 'a' },
        { login: 'inkeep', kind: 'org' },
      ],
    });
  });

  test('CLI auth-required event → ok:false / auth-required', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'auth-required' })),
    });
    const { status, body } = await getJson(rig.port, '/api/share/publish/owners');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'auth-required' });
  });

  test('garbage stdout → ok:false / network', async () => {
    rig = await bootRig({
      cliArgs: [process.execPath, '-e', `process.stdout.write("not json\\n")`],
    });
    const { status, body } = await getJson(rig.port, '/api/share/publish/owners');
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'network' });
  });

  test('rejects POST with 405', async () => {
    rig = await bootRig({ cliArgs: fixtureCliArgs('{}') });
    const res = await fetch(`${rig.baseUrl}/api/share/publish/owners`, {
      method: 'POST',
    });
    expect(res.status).toBe(405);
  });
});


describe('GET /api/share/publish/name-check', () => {
  let rig: TestRig;
  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test('happy path: available=true round-trips', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'name-check', available: true })),
    });
    const { status, body } = await getJson(
      rig.port,
      '/api/share/publish/name-check?owner=alice&name=foo',
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, available: true });
  });

  test('happy path: available=false round-trips', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'name-check', available: false })),
    });
    const { status, body } = await getJson(
      rig.port,
      '/api/share/publish/name-check?owner=alice&name=taken',
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, available: false });
  });

  test('rejects malformed owner with 400 before spawning', async () => {
    rig = await bootRig({
      cliArgs: [
        process.execPath,
        '-e',
        `process.stderr.write("FIXTURE INVOKED — should not happen for invalid owner");process.exit(99);`,
      ],
    });
    const res = await fetch(`${rig.baseUrl}/api/share/publish/name-check?owner=-bad&name=foo`);
    expect(res.status).toBe(400);
  });

  test('rejects malformed name with 400 before spawning', async () => {
    rig = await bootRig({
      cliArgs: [process.execPath, '-e', `process.exit(99);`],
    });
    const res = await fetch(
      `${rig.baseUrl}/api/share/publish/name-check?owner=alice&name=with%2Fslash`,
    );
    expect(res.status).toBe(400);
  });
});


describe('POST /api/share/publish', () => {
  let rig: TestRig;
  afterEach(async () => {
    if (rig) await rig.cleanup();
  });

  test('happy path: full success body round-trips', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(
        JSON.stringify({
          type: 'publish',
          ownerLogin: 'alice',
          repoName: 'demo',
          cloneUrl: 'https://github.com/alice/demo.git',
          defaultBranch: 'main',
        }),
      ),
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      ownerLogin: 'alice',
      repoName: 'demo',
      cloneUrl: 'https://github.com/alice/demo.git',
      defaultBranch: 'main',
    });
  });

  test('CLI auth-required event surfaces as ok:false / auth-required', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'auth-required' })),
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'auth-required' });
  });

  test('CLI name-conflict event surfaces as ok:false / name-conflict', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'name-conflict' })),
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'inkeep',
      name: 'open-knowledge',
      visibility: 'public',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'name-conflict' });
  });

  test('CLI saml-sso event surfaces as ok:false / saml-sso', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'saml-sso' })),
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'sso-org',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'saml-sso' });
  });

  test('CLI push-failed event surfaces as ok:false / push-failed', async () => {
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'push-failed' })),
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'push-failed' });
  });

  test('no-project when server has no projectDir set', async () => {
    rig = await bootRig({
      cliArgs: [process.execPath, '-e', `process.exit(99);`],
      withProjectDir: false,
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: false, error: 'no-project' });
  });

  test('malformed body returns 400 before spawning', async () => {
    rig = await bootRig({
      cliArgs: [process.execPath, '-e', `process.exit(99);`],
    });
    const res = await fetch(`${rig.baseUrl}/api/share/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'alice', name: 'demo', visibility: 'lobster' }),
    });
    expect(res.status).toBe(400);
  });

  test('malformed name rejected with 400 before spawning', async () => {
    rig = await bootRig({
      cliArgs: [process.execPath, '-e', `process.exit(99);`],
    });
    const res = await fetch(`${rig.baseUrl}/api/share/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'alice', name: 'with space', visibility: 'private' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET method rejected with 405', async () => {
    rig = await bootRig({ cliArgs: fixtureCliArgs('{}') });
    const res = await fetch(`${rig.baseUrl}/api/share/publish`);
    expect(res.status).toBe(405);
  });

  test('successful publish nudges the sync engine to re-detect the remote', async () => {
    const fake = makeFakeSyncEngine();
    rig = await bootRig({
      cliArgs: fixtureCliArgs(
        JSON.stringify({
          type: 'publish',
          ownerLogin: 'alice',
          repoName: 'demo',
          cloneUrl: 'https://github.com/alice/demo.git',
          defaultBranch: 'main',
        }),
      ),
      getSyncEngine: () => fake.engine,
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect(fake.refreshRemoteCalls()).toBe(1);
  });

  test('failed publish does NOT nudge the sync engine', async () => {
    const fake = makeFakeSyncEngine();
    rig = await bootRig({
      cliArgs: fixtureCliArgs(JSON.stringify({ type: 'error', code: 'name-conflict' })),
      getSyncEngine: () => fake.engine,
    });
    const { status, body } = await postJson(rig.port, '/api/share/publish', {
      owner: 'alice',
      name: 'demo',
      visibility: 'private',
    });
    expect(status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(false);
    expect(fake.refreshRemoteCalls()).toBe(0);
  });
});
