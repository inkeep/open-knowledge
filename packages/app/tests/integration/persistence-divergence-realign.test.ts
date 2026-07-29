/**
 * The L3 store-time divergence realign as a CONTENT-LOSS site.
 *
 * `disk-divergence-backstop.test.ts` already pins the arm's disk-authority
 * contract: on a TOCTOU divergence the store aborts, disk wins, and the agent
 * gets a 409. That contract is correct and this suite does not touch it. What
 * that suite never asks is what happens to the LIVE DOCUMENT the realign
 * overwrites — and the answer is that everything the CRDT held goes away.
 *
 * The realign applies disk over the doc under `FILE_WATCHER_ORIGIN`, which the
 * server UndoManager excludes by contract and which reaches browsers as a
 * remote update outside any local `trackedOrigins` set. So the discarded state
 * is undoable on neither side, and until this suite it minted no restore anchor
 * and reported no loss-ring breadcrumb. The bytes at risk are not only the
 * agent's rejected write — a human's in-flight WYSIWYG paragraph that merged
 * alongside it in the same Y.Doc is destroyed too, and the human is never told.
 *
 * That is the same shape as the duplication tripwire one arm above it in
 * `onStoreDocument`, audited as Gap 1 of the content-loss class sweep. The
 * difference is that this arm fires on a REAL external-writer conflict rather
 * than a false positive, so the repair itself stays — what it owes is
 * recoverability and a signal, not a narrower trigger.
 *
 * Fidelity: real boot (`createTestServer`), real HTTP agent-write path, real
 * `onStoreDocument`, real WS client, real shadow repo, real loss ring. The only
 * affordance is the `OK_TEST_STORE_DIVERGENCE` seam the sibling L3 suite
 * already relies on — a real native edit cannot be timed into the residual
 * TOCTOU window deterministically, because the file watcher races it and can
 * flip `lastTransactionOrigin` to file-watcher, gating L3 out entirely.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

/** Must match the content the `OK_TEST_STORE_DIVERGENCE` seam writes. */
const INJECTED_MARKER = 'native-divergence-injected';

/**
 * A human's in-flight paragraph, live in the CRDT and not yet on disk when the
 * realign fires. Distinctive so a substring search cannot false-match.
 */
const HUMAN_PENDING_LINE = 'Zzz human paragraph typed before the realign.';

const AGENT_LINE = 'AGENT-APPEND-XYZ';

interface LossRingEvent {
  event: string;
  docName: string;
  site?: string;
  direction?: string;
  writerId?: string | null;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
}

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_DIVERGENCE;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

function readLossEvents(contentDir: string): LossRingEvent[] {
  const path = join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LossRingEvent];
      } catch {
        return [];
      }
    });
}

/** The shadow repo the harness boots — `<projectDir>/.git/ok` (main-worktree shape). */
function shadowDirFor(s: TestServer): string {
  const dir = join(s.contentDir, '.git', 'ok');
  if (!existsSync(dir)) {
    throw new Error(`shadow repo not found at ${dir}; the rig needs gitEnabled: true`);
  }
  return dir;
}

function shadowGitRaw(s: TestServer, args: string[]): string {
  return execFileSync('git', ['--git-dir', shadowDirFor(s), ...args], {
    encoding: 'utf-8',
  }).toString();
}

/**
 * Every checkpoint the shadow holds, listed across ALL branch namespaces rather
 * than the one this test would otherwise have to guess. Checkpoint refs are
 * namespaced `refs/checkpoints/<branch>` off the real repo HEAD, so a machine
 * defaulting to `master` files the anchor somewhere a `refs/checkpoints/main`
 * listing does not look.
 */
function listCheckpoints(s: TestServer): Array<{ sha: string; kind: string | null }> {
  const shas = shadowGitRaw(s, ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints'])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return shas.map((sha) => ({
    sha,
    kind: parseCheckpoint(shadowGitRaw(s, ['log', '-1', '--format=%B', sha]))?.kind ?? null,
  }));
}

async function agentWriteMd(
  port: number,
  markdown: string,
  opts: { docName: string; position: 'append' | 'prepend' | 'replace' },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, ...opts }),
  });
}

async function pollUntil(
  predicate: () => boolean,
  { timeoutMs = 10_000, pollMs = 50 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

describe('L3 agent-write divergence realign — content-loss conventions', () => {
  test(
    'the realign checkpoints the live document and reports the loss before discarding it',
    async () => {
      server = await createTestServer({
        gitEnabled: true,
        // Persistence must not flush on its own: the human paragraph has to still
        // be live-and-unpersisted at the moment the agent write forces the store.
        debounce: 300_000,
        maxDebounce: 600_000,
      });
      const { port, contentDir } = server;
      const docName = `realign-${randomUUID().slice(0, 8)}`;
      const docPath = join(contentDir, `${docName}.md`);

      // Seed through the agent path. This forces a flush, so disk, the reconciled
      // base, and the live document all agree before anything diverges.
      const seed = await agentWriteMd(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' });
      expect(seed.status).toBe(200);
      await pollUntil(
        () => existsSync(docPath) && readFileSync(docPath, 'utf-8').includes('body-v1'),
      );

      // A human is typing in the browser. Real WS client, real remote update.
      const client = await createTestClient(port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => client.ytext.toString().includes('body-v1'));
      const before = client.ytext.toString();
      client.doc.transact(() => {
        client.ytext.insert(before.length, `\n${HUMAN_PENDING_LINE}\n`);
      });
      await pollUntil(() =>
        Boolean(
          server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(HUMAN_PENDING_LINE),
        ),
      );
      // Precondition: the human's bytes are live but NOT on disk. Everything this
      // test claims is destroyed has to actually be at risk.
      expect(readFileSync(docPath, 'utf-8')).not.toContain(HUMAN_PENDING_LINE);

      // Arm the in-store divergence: a native writer lands between L1's reconcile
      // and this store's write, which is the residual TOCTOU L3 exists to catch.
      process.env.OK_TEST_STORE_DIVERGENCE = docName;

      const attempt = await agentWriteMd(port, `${AGENT_LINE}\n`, { docName, position: 'append' });
      expect(attempt.status).toBe(409);
      expect(((await attempt.json()) as { type?: string }).type).toBe(
        'urn:ok:error:disk-divergence',
      );

      // Disk-authority contract, unchanged: the native content wins.
      await pollUntil(() => readFileSync(docPath, 'utf-8').includes(INJECTED_MARKER));
      expect(readFileSync(docPath, 'utf-8')).not.toContain(AGENT_LINE);

      // The premise of this suite: the realign took the human's live paragraph
      // with it. This assertion PASSES on the unfixed tree — it documents the
      // harm rather than the gap.
      await pollUntil(
        () =>
          !server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(HUMAN_PENDING_LINE),
      );

      // (a) checkpoint-before-repair and (b) detection-site-owns-a-kind: the
      // discarded document must be reachable again, under a kind an operator can
      // tell apart from the tripwire reset and from the pre-write reconcile.
      const rig = server;
      await pollUntil(() =>
        listCheckpoints(rig).some((c) => c.kind === 'persistence-divergence-realign'),
      );
      const anchors = listCheckpoints(rig).filter(
        (c) => c.kind === 'persistence-divergence-realign',
      );
      expect(anchors).toHaveLength(1);
      const anchor = anchors[0];
      if (!anchor) throw new Error('unreachable: anchor asserted above');

      // (c) undoability: `FILE_WATCHER_ORIGIN` is reachable by neither undo stack,
      // so the anchor is the only way back. Prove it holds the real bytes rather
      // than merely existing — the blob must carry the human's paragraph.
      const blob = shadowGitRaw(rig, ['show', `${anchor.sha}:${docName}`]);
      expect(blob).toContain(HUMAN_PENDING_LINE);

      // (d) observable signal: the loss ring must carry a detector trip for this
      // site, and the checkpoint write, so a diagnostics bundle shows the event.
      const ring = readLossEvents(contentDir).filter(
        (e) => e.site === 'persistence-divergence-realign' && e.docName === docName,
      );
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.direction).toBe('b');
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThanOrEqual(HUMAN_PENDING_LINE.length);
      // Content-free ring: never the lost bytes themselves.
      expect(JSON.stringify(trips[0])).not.toContain(HUMAN_PENDING_LINE);
      // Polled, not asserted once: git creates the checkpoint ref before the write
      // promise settles, so the anchor is visible to `for-each-ref` a beat before
      // the `.then` records its ring event.
      await pollUntil(() =>
        readLossEvents(contentDir).some(
          (e) =>
            e.site === 'persistence-divergence-realign' &&
            e.event === 'checkpoint-write' &&
            e.checkpointSha === anchor.sha,
        ),
      );

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );
});
