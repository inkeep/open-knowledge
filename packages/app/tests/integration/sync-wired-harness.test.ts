/**
 * S2 substrate smoke tests for the sync-wired harness mode.
 *
 * `createSyncWiredTestServer` boots a real server whose SyncEngine is attached
 * to a bare origin repo. These tests prove the composed background-sync chain is
 * drivable in-process — seed an upstream commit, drive one pull, and observe the
 * fast-forward land on disk, in a live CRDT doc, and in the engine's status — so
 * downstream stories (the B1 pull cycle, one-shot pull, mode transitions) can
 * assert against the real fetch → merge → import → status path rather than a
 * stubbed engine.
 */

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
    // Disconnect clients before tearing down their servers so the per-doc
    // testReset in client cleanup still has a live server to talk to.
    for (const client of clients.splice(0)) {
      await client.cleanup().catch(() => {});
    }
    for (const server of servers.splice(0)) {
      await server.cleanup().catch(() => {});
    }
  });

  /**
   * The composed background-pull chain end to end: an upstream commit
   * fast-forwards into the follower's working tree, loads into a live CRDT
   * doc on connect, and settles the engine's status fields.
   *
   */
  test(
    'full mode: an upstream commit fast-forwards to disk, into the CRDT, and updates status',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'full',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      // The engine attached to the origin at boot and parked idle without
      // fetching yet — the composed chain has a clean starting line.
      const before = engine.getStatus();
      expect(before.hasRemote).toBe(true);
      expect(before.syncMode).toBe('full');
      expect(before.state).toBe('idle');
      expect(before.lastFetchUtc).toBeNull();

      // A teammate pushes: modify the seeded doc and add a brand-new one.
      await server.sync.pushToOrigin({
        'guide.md': '# Guide\n\nversion two from origin\n',
        'briefing.md': '# Briefing\n\nbrand new upstream doc\n',
      });

      await engine.trigger('pull');

      // Sync status reflects the outcome of a clean fast-forward.
      const after = engine.getStatus();
      expect(after.state).toBe('idle');
      expect(after.behind).toBe(0);
      expect(after.conflictCount).toBe(0);
      expect(after.lastFetchUtc).not.toBeNull();

      // The fast-forward wrote the working tree: both files land on disk.
      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain(
        'version two from origin',
      );
      expect(readFileSync(join(server.contentDir, 'briefing.md'), 'utf-8')).toContain(
        'brand new upstream doc',
      );

      // The CRDT reflects the pulled content: the server indexes the new file
      // and a connecting client loads it through persistence into a live Y.Doc.
      await awaitFileWatcherIndexed(server, 'briefing');
      const client = await createTestClient(server.port, 'briefing');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('brand new upstream doc'));
      expect(serializeFragment(client.fragment)).toContain('brand new upstream doc');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  /**
   * Pull-only mode attaches to the remote (idle, not dormant) and fast-forwards
   * an upstream commit onto disk — the same composed chain without a push side.
   *
   */
  test(
    'pull-only mode: attaches to the remote and fast-forwards an upstream commit',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      // Pull-only is a first-class attached mode — not dormant/disabled — and
      // reports itself through the additive syncMode status field.
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

  /**
   * The B1 fast-forward composed through the whole stack: a doc opened BEFORE the
   * pull updates in place when the upstream commit lands, the branch reaches
   * origin's tip, and the pull-only cycle leaves no git residue (no commit, no
   * MERGE_HEAD). Connecting first is what distinguishes this from a
   * load-from-disk-on-connect assertion — the FF must import into a live Y.Doc.
   *
   */
  test(
    'pull-only: a background fast-forward updates an already-open live doc with no git residue',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nversion one\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      // Open the doc first, so the pull must reconcile into a live CRDT doc
      // rather than merely land bytes a later connect would read from disk.
      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('version one'));

      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nversion two from origin\n' });
      await engine.trigger('pull');

      const after = engine.getStatus();
      expect(after.state).toBe('idle');
      expect(after.behind).toBe(0);

      // Branch fast-forwarded to origin's tip.
      expect(await revParse(server.contentDir, 'HEAD')).toBe(
        await revParse(server.contentDir, 'origin/main'),
      );

      // The already-open Y.Doc reflects the pulled content in place.
      await pollUntil(() => serializeFragment(client.fragment).includes('version two from origin'));
      expect(serializeFragment(client.fragment)).toContain('version two from origin');

      // Pull-only never commits or merges: no MERGE_HEAD, no stash residue.
      expect(existsSync(join(server.contentDir, '.git', 'MERGE_HEAD'))).toBe(false);
      const { stdout: stashList } = await execFileAsync('git', ['stash', 'list'], {
        cwd: server.contentDir,
      });
      expect(stashList.trim()).toBe('');
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  /**
   * A same-line collision composed through the whole stack: the conflict-content
   * endpoint serves `theirs`/`base` from the pinned blobs and `ours` from the
   * overlay (live Y.Doc once open), and an HTTP take-theirs resolution writes the
   * tip version and clears the conflict — all without a git commit. Opening the
   * doc loads the disk overlay into a live CRDT doc, covering the disk→CRDT path.
   *
   */
  test(
    'pull-only: a same-line collision surfaces conflict-content and resolves via HTTP with no commit',
    async () => {
      const server = await createSyncWiredTestServer({
        mode: 'follow',
        originSeed: { 'guide.md': '# Guide\n\nintro\n\noutro\n' },
      });
      servers.push(server);
      const { engine } = server.sync;

      // Local overlay edits the intro; origin edits the SAME line — a collision.
      writeFileSync(
        join(server.contentDir, 'guide.md'),
        '# Guide\n\nLOCAL intro\n\noutro\n',
        'utf-8',
      );
      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nORIGIN intro\n\noutro\n' });
      await engine.trigger('pull');

      // The branch reached origin tip; the overlay is kept on disk; a working-tree
      // conflict is tracked.
      expect(await revParse(server.contentDir, 'HEAD')).toBe(
        await revParse(server.contentDir, 'origin/main'),
      );
      expect(readFileSync(join(server.contentDir, 'guide.md'), 'utf-8')).toContain('LOCAL intro');
      const conflicts = engine.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.variant).toBe('working-tree');

      // conflict-content serves theirs/base from the pinned blobs; ours from the
      // on-disk overlay (no doc open yet).
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

      // Opening the doc loads the disk overlay into a live CRDT doc and the
      // lifecycle seed flips it into conflict; conflict-content then serves ours
      // from the live Y.Text.
      const client = await createTestClient(server.port, 'guide');
      clients.push(client);
      await pollUntil(() => serializeFragment(client.fragment).includes('LOCAL intro'));
      const ytextRes = await fetch(`${base}?file=guide.md&source=ytext`);
      const ytextBody = (await ytextRes.json()) as { ours: string; lifecycleStatus: string | null };
      expect(ytextBody.ours).toContain('LOCAL intro');
      expect(ytextBody.lifecycleStatus).toBe('conflict');
      await pollUntil(() => client.doc.getMap('lifecycle').get('status') === 'conflict');

      // Keep-mine over HTTP leaves the overlay untouched (no disk change), so the
      // conflict lifecycle clears only via the resolved callback — not the
      // file-watcher's `case 'update'`. The overlay survives, the conflict is
      // gone, the lifecycle clears on the client, and nothing was committed.
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

  /**
   * The one-shot pull contract composed through the real HTTP surface: a
   * consumer reads status, POSTs `trigger {op:'pull'}` (202 fire-and-forget),
   * then waits for `lastPullUtc` to change and reads `lastPullOutcome` — the
   * change-detection consumer pattern end to end. The upstream commit
   * fast-forwards to disk and into a live CRDT doc.
   *
   */
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

      // The consumer reads status before triggering — no pull has completed yet.
      const before = (await (await fetch(statusUrl)).json()) as PullStatus;
      expect(before.lastPullUtc ?? null).toBeNull();

      // A teammate pushes an upstream change.
      await server.sync.pushToOrigin({ 'guide.md': '# Guide\n\nversion two from origin\n' });

      // Trigger a one-shot pull: 202 Accepted, background execution (no
      // synchronous outcome in the response body — the consumer polls status).
      const triggerRes = await fetch(triggerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'pull' }),
      });
      expect(triggerRes.status).toBe(202);
      expect(((await triggerRes.json()) as { op: string }).op).toBe('pull');

      // Wait for lastPullUtc to change, then read the outcome (the
      // change-detection consumer pattern: read-before-trigger,
      // wait-for-change, give-up-timeout).
      let after: PullStatus = before;
      await pollUntil(async () => {
        after = (await (await fetch(statusUrl)).json()) as PullStatus;
        return after.lastPullUtc != null && after.lastPullUtc !== (before.lastPullUtc ?? null);
      });
      expect(after.lastPullOutcome).toBe('succeeded');

      // The fast-forward landed on disk and imports into a live CRDT doc.
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
