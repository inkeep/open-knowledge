import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitFileWatcherIndexed,
  createSyncWiredTestServer,
  createTestClient,
  pollUntil,
  type SyncWiredTestServer,
  serializeFragment,
  type TestClient,
} from './test-harness';

const execFileAsync = promisify(execFile);

async function revParse(dir: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd: dir });
  return stdout.trim();
}

describe('sync-wired harness (S2 substrate)', () => {
  const servers: SyncWiredTestServer[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.cleanup().catch(() => {});
    }
    for (const server of servers.splice(0)) {
      await server.cleanup().catch(() => {});
    }
  });

  test(
    'full mode: an upstream commit fast-forwards to disk, into the CRDT, and updates status',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'full',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      const before = engine.getStatus();
      expect(before.hasRemote).toBe(true);
      expect(before.syncMode).toBe('full');
      expect(before.state).toBe('idle');
      expect(before.lastFetchUtc).toBeNull();

      await server.sync.pushToOrigin({
        'guide.md': '# Guide\n\nversion two from origin\n',
        'briefing.md': '# Briefing\n\nbrand new upstream doc\n',
      });

      await engine.trigger('pull');

      const after = engine.getStatus();
      expect(after.state).toBe('idle');
      expect(after.behind).toBe(0);
      expect(after.conflictCount).toBe(0);
      expect(after.lastFetchUtc).not.toBeNull();

      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain(
        'version two from origin',
      );
      expect(readFileSync(join(server.contentDir, 'briefing.md'), 'utf-8')).toContain(
        'brand new upstream doc',
      );

      await awaitFileWatcherIndexed(server, 'briefing');
      const client = await createTestClient(server.port, 'briefing');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('brand new upstream doc'));
      expect(serializeFragment(client.fragment)).toContain('brand new upstream doc');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'pull-only mode: attaches to the remote and fast-forwards an upstream commit',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      const before = engine.getStatus();
      expect(before.hasRemote).toBe(true);
      expect(before.syncMode).toBe('follow');
      expect(before.state).toBe('idle');

      await server.sync.pushToOrigin({
        'briefing.md': '# Briefing\n\nfollower reads this\n',
      });

      await engine.trigger('pull');

      const after = engine.getStatus();
      expect(after.state).toBe('idle');
      expect(after.behind).toBe(0);
      expect(after.conflictCount).toBe(0);
      expect(readFileSync(join(server.contentDir, 'briefing.md'), 'utf-8')).toContain(
        'follower reads this',
      );
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'pull-only: a background fast-forward updates an already-open live doc with no git residue',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('version one'));

      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nversion two from origin\n' });
      await engine.trigger('pull');

      const after = engine.getStatus();
      expect(after.state).toBe('idle');
      expect(after.behind).toBe(0);

      expect(await revParse(server.contentDir, 'HEAD')).toBe(
        await revParse(server.contentDir, 'origin/main'),
      );

      await pollUntil(() => serializeFragment(client.fragment).includes('version two from origin'));
      expect(serializeFragment(client.fragment)).toContain('version two from origin');

      expect(existsSync(join(server.contentDir, '.git', 'MERGE_HEAD'))).toBe(false);
      const { stdout: stashList } = await execFileAsync('git', ['stash', 'list'], {
        cwd: server.contentDir,
      });
      expect(stashList.trim()).toBe('');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'pull-only: a same-line collision surfaces conflict-content and resolves via HTTP with no commit',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nintro\n\noutro\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      writeFileSync(
        join(server.contentDir, 'guide.md'),
        '# Guide\n\nLOCAL intro\n\noutro\n',
        'utf-8',
      );
      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nORIGIN intro\n\noutro\n' });
      await engine.trigger('pull');

      expect(await revParse(server.contentDir, 'HEAD')).toBe(
        await revParse(server.contentDir, 'origin/main'),
      );
      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain('LOCAL intro');
      const conflicts = engine.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.variant).toBe('working-tree');

      const base = `http://127.0.0.1:${server.port}/api/sync/conflict-content`;
      const diskRes = await fetch(`${base}?file=guide.md`);
      expect(diskRes.status).toBe(200);
      const diskBody = (await diskRes.json()) as {
        base: string;
        ours: string;
        theirs: string;
        kind: string;
      };
      expect(diskBody.kind).toBe('both-modified');
      expect(diskBody.theirs).toContain('ORIGIN intro');
      expect(diskBody.ours).toContain('LOCAL intro');
      expect(diskBody.base).toContain('intro');
      expect(diskBody.base).not.toContain('ORIGIN');
      expect(diskBody.base).not.toContain('LOCAL');

      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('LOCAL intro'));
      const ytextRes = await fetch(`${base}?file=guide.md&source=ytext`);
      const ytextBody = (await ytextRes.json()) as { ours: string; lifecycleStatus: string | null };
      expect(ytextBody.ours).toContain('LOCAL intro');
      expect(ytextBody.lifecycleStatus).toBe('conflict');
      await pollUntil(() => client.doc.getMap('lifecycle').get('status') === 'conflict');

      const resolveRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'guide.md', strategy: 'mine' }),
      });
      expect(resolveRes.status).toBe(200);
      expect(engine.getConflicts()).toEqual([]);
      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain('LOCAL intro');
      await pollUntil(() => client.doc.getMap('lifecycle').get('status') === undefined);
      expect(existsSync(join(server.contentDir, '.git', 'MERGE_HEAD'))).toBe(false);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'one-shot pull over HTTP: 202 accept, then status carries lastPullUtc + a succeeded outcome',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const statusUrl = `http://127.0.0.1:${server.port}/api/sync/status`;
      const triggerUrl = `http://127.0.0.1:${server.port}/api/sync/trigger`;
      type PullStatus = { lastPullUtc: string | null; lastPullOutcome: string | null };

      const before = (await (await fetch(statusUrl)).json()) as PullStatus;
      expect(before.lastPullUtc ?? null).toBeNull();

      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nversion two from origin\n' });

      const triggerRes = await fetch(triggerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'pull' }),
      });
      expect(triggerRes.status).toBe(202);
      expect(((await triggerRes.json()) as { op: string }).op).toBe('pull');

      let after: PullStatus = before;
      await pollUntil(async () => {
        after = (await (await fetch(statusUrl)).json()) as PullStatus;
        return after.lastPullUtc != null && after.lastPullUtc !== (before.lastPullUtc ?? null);
      });
      expect(after.lastPullOutcome).toBe('succeeded');

      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain(
        'version two from origin',
      );
      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('version two from origin'));
      expect(serializeFragment(client.fragment)).toContain('version two from origin');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
