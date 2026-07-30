/**
 * The managed-artifact concurrent-writer reconcile as a CONTENT-LOSS site.
 *
 * `storeManagedArtifactDoc` refuses to clobber a file a second writer changed
 * under it: when the pre-write disk read shows `disk !== lkg && disk !== content`
 * it imports the disk bytes over the live doc and returns `'reconciled'`. The
 * disk-wins decision is correct — another OK window, a hand edit, or a CLI write
 * is a real conflict, not a false positive — but the import lands under
 * `FILE_WATCHER_ORIGIN`, which the server UndoManager excludes by contract and
 * which reaches browsers as a remote update outside any local `trackedOrigins`
 * set. Whatever the author had typed into the artifact is gone on both sides.
 *
 * `'reconciled'` propagates to in-process consumers, so the path is not wholly
 * silent, but nothing reaches the loss ring and nothing is restorable. That is
 * Gap 2 of the content-loss class sweep, and the same three misses as Gap 1:
 * no checkpoint, no kind of its own, no `detect`.
 *
 * Templates are the versioned managed artifact — they live under the project's
 * `.ok/templates/`, inside the shadow repo's reach. Global skills live at
 * `<home>/.ok/skills` outside any project shadow, so they are unversioned by
 * construction and covered separately at the unit rung.
 *
 * Fidelity: real boot, real WS client, real `onStoreDocument` managed-artifact
 * branch, real file lock, real shadow repo. The divergent write is a plain
 * `writeFileSync`. The test invokes the real store hook immediately afterward
 * so the managed-artifact watcher cannot consume the same change first and turn
 * this into coverage of its separate disk-intake path.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

/** What the author had typed into the template and had not yet stored. */
const AUTHOR_PENDING_LINE = 'Zzz author sentence pending when the reconcile fired.';

/** What the concurrent writer put on disk underneath the live doc. */
const FOREIGN_LINE = 'Foreign edit from a second OK window.';

interface LossRingEvent {
  event: string;
  docName: string;
  site?: string;
  direction?: string;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
}

let server: TestServer | undefined;

afterEach(async () => {
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

function shadowGitRaw(s: TestServer, args: string[]): string {
  const dir = join(s.contentDir, '.git', 'ok');
  if (!existsSync(dir)) {
    throw new Error(`shadow repo not found at ${dir}; the rig needs gitEnabled: true`);
  }
  return execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf-8' }).toString();
}

/** Every checkpoint the shadow holds, across all branch namespaces. */
function listCheckpoints(s: TestServer): Array<{ sha: string; kind: string | null }> {
  return shadowGitRaw(s, ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints'])
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((sha) => ({
      sha,
      kind: parseCheckpoint(shadowGitRaw(s, ['log', '-1', '--format=%B', sha]))?.kind ?? null,
    }));
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

async function storeImmediately(rig: TestServer, docName: string): Promise<void> {
  const document = rig.instance.hocuspocus.documents.get(docName);
  if (!document) throw new Error(`document not loaded: ${docName}`);

  await rig.instance.hocuspocus.hooks('onStoreDocument', {
    clientsCount: document.getConnectionsCount(),
    document,
    lastContext: {},
    lastTransactionOrigin: undefined,
    documentName: docName,
    instance: rig.instance.hocuspocus,
  });
}

describe('managed-artifact reconcile-on-divergence — content-loss conventions', () => {
  test(
    'the reconcile checkpoints the live artifact and reports the loss before discarding it',
    async () => {
      server = await createTestServer({ gitEnabled: true, debounce: 150, maxDebounce: 600 });
      const name = `tpl-${randomUUID().slice(0, 8)}`;
      const docName = `__template__/${name}`;
      const tplFile = resolve(server.contentDir, '.ok', 'templates', `${name}.md`);

      const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });

      // v1 authored in the editor and persisted — this is what sets the LKG.
      const v1 = `---\ntitle: T\ndescription: d\n---\n\n# Template\n\nv1 body.\n`;
      client.doc.transact(() => client.ytext.insert(0, v1));
      await pollUntil(() => existsSync(tplFile) && readFileSync(tplFile, 'utf-8') === v1);

      // The author keeps typing. These bytes are live and unstored.
      const live = client.ytext.toString();
      client.doc.transact(() => client.ytext.insert(live.length, `\n${AUTHOR_PENDING_LINE}\n`));
      await pollUntil(() =>
        Boolean(
          server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(AUTHOR_PENDING_LINE),
        ),
      );

      // A second writer changes the file underneath us. Invoke the real store
      // hook in the same turn so this test deterministically reaches the
      // concurrent-writer reconcile before the separate template watcher can
      // import the file.
      mkdirSync(resolve(tplFile, '..'), { recursive: true });
      const foreign = `---\ntitle: T\ndescription: d\n---\n\n# Template\n\n${FOREIGN_LINE}\n`;
      writeFileSync(tplFile, foreign, 'utf-8');
      await storeImmediately(server, docName);

      // The next store reads disk, sees `disk !== lkg && disk !== content`, and
      // reconciles: the foreign bytes win and the author's sentence is discarded.
      // This premise assertion PASSES on the unfixed tree — it documents the harm.
      await pollUntil(
        () =>
          Boolean(
            server?.instance.hocuspocus.documents
              .get(docName)
              ?.getText('source')
              .toString()
              .includes(FOREIGN_LINE),
          ) &&
          !server?.instance.hocuspocus.documents
            .get(docName)
            ?.getText('source')
            .toString()
            .includes(AUTHOR_PENDING_LINE),
        { timeoutMs: 15_000 },
      );

      // (a) checkpoint-before-repair + (b) detection-site-owns-a-kind.
      const rig = server;
      await pollUntil(
        () => listCheckpoints(rig).some((c) => c.kind === 'managed-artifact-reconcile'),
        { timeoutMs: 15_000 },
      );
      const anchors = listCheckpoints(rig).filter((c) => c.kind === 'managed-artifact-reconcile');
      expect(anchors).toHaveLength(1);
      const anchor = anchors[0];
      if (!anchor) throw new Error('unreachable: anchor asserted above');

      // (c) undoability: the anchor is the only way back, so it must hold the
      // author's real bytes. The checkpoint is filed under the artifact's TIMELINE
      // key (`.ok/templates/<name>`), not the synthetic `__template__/...` doc
      // name, so it addresses the same path the history surface reads.
      const blob = shadowGitRaw(rig, ['show', `${anchor.sha}:.ok/templates/${name}`]);
      expect(blob).toContain(AUTHOR_PENDING_LINE);

      // (d) observable signal.
      const ring = readLossEvents(rig.contentDir).filter(
        (e) => e.site === 'managed-artifact-reconcile' && e.docName === docName,
      );
      const trips = ring.filter((e) => e.event === 'detector-trip');
      expect(trips).toHaveLength(1);
      expect(trips[0]?.lostLen ?? 0).toBeGreaterThanOrEqual(AUTHOR_PENDING_LINE.length);
      expect(JSON.stringify(trips[0])).not.toContain(AUTHOR_PENDING_LINE);
      // Polled, not asserted once: git creates the checkpoint ref before the write
      // promise settles, so the anchor is visible to `for-each-ref` a beat before
      // the `.then` records its ring event.
      await pollUntil(() =>
        readLossEvents(rig.contentDir).some(
          (e) =>
            e.site === 'managed-artifact-reconcile' &&
            e.event === 'checkpoint-write' &&
            e.checkpointSha === anchor.sha,
        ),
      );

      await client.cleanup();
    },
    HARNESS_BOOT_TIMEOUT_MS + 60_000,
  );
});
