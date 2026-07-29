/**
 * H3 public-path loss injection: drive a paired-intake content loss through the
 * REAL boot path — `createServer` wires the loss ring + the derive-loss reporter
 * to the agent-write spine (`session.bridgeLossReporter`) — and assert the
 * detector fires a content-free ring event + a restorable shadow-git checkpoint.
 *
 * The un-propagated window is staged on the booted server's own Y.Doc via a
 * freshness-suppressed Observer A settlement (a component's advanced children
 * while Y.Text lags), the same technique the derive-timing full-flow rig uses;
 * only `Date` is faked so the real WS + async I/O proceed. The derive-timing
 * defer guard is config-disabled so the loss path is exercised (paired vectors
 * don't defer, but disabling it removes any interaction).
 *
 * Direction coverage split by achievable rung: this suite owns the B /
 * paired-intake direction end to end for both of its vectors — the agent write
 * (through a public HTTP path) and the passive disk intake (through the real
 * file watcher the harness already runs). The Observer-A (fragment→Y.Text) apply
 * direction stays injection-tested at the server rung
 * (`bridge-loss-detector.test.ts`); its seam has no booted driver.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, getServerState, mdManager, type TestServer } from './test-harness.ts';

const schema = getSchema(sharedExtensions);
// The server serializes freshness-ON (its md-manager singleton), so a component's
// advanced children reach the detector; the harness `mdManager` is freshness-OFF.
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
// A distinctive whole-line replacement: the pending content must be its own
// unique segment (a 2-char edit like `bod`→`body.` collides with common
// substrings of the replacement content and the segment diff filters it out).
const PENDING_LINE = 'Zzz unpropagated pending sentinel keystroke.';

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

function mutateFirstText(node: JSONContent, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

/** Freshness-ON serialize — sees a component's live children, not stale sourceRaw. */
function serializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

/** Read the content-free loss ring straight off disk (no server-internal import). */
function readLossEvents(contentDir: string): LossRingEvent[] {
  try {
    const raw = readFileSync(
      join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl'),
      'utf-8',
    );
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LossRingEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function pollForTrip(
  contentDir: string,
  predicate: (e: LossRingEvent) => boolean,
  timeoutMs = 8000,
): Promise<LossRingEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = readLossEvents(contentDir).find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for a detector-trip loss-ring event');
}

/**
 * Stage a fragment-ahead-of-Y.Text divergence on the booted server's own doc:
 * poke Y.Text to reset the freshness clock, then advance the component children
 * to `PENDING_LINE` while `sourceRaw` lags → Observer A settles on the stale
 * bytes, leaving the fragment holding content Y.Text lacks.
 */
function stageUnpropagatedKeystroke(doc: Y.Doc, ytext: Y.Text, fragment: Y.XmlFragment): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  doc.transact(() => {
    ytext.insert(ytext.length, '\nTrailing.\n');
  }, 'external-peer');
  const echo = mdManager.parse(ytext.toString()) as JSONContent;
  expect(mutateFirstText(echo, STALE_LINE, PENDING_LINE)).toBe(true);
  doc.transact(() => {
    updateYFragment(doc, fragment, schema.nodeFromJSON(echo), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, 'wysiwyg-echo');
  expect(serializeFragment(fragment)).toContain(PENDING_LINE);
  expect(ytext.toString()).not.toContain(PENDING_LINE);
  vi.useRealTimers();
}

/** A fresh contentDir with the derive-timing defer guard disabled in `.ok/config.yml`. */
function guardDisabledContentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-loss-injection-'));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), 'bridge:\n  deferGuard:\n    enabled: false\n');
  return dir;
}

describe('H3 paired-intake loss injection through public paths', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await createTestServer({
      contentDir: guardDisabledContentDir(),
      gitEnabled: true,
      // Pin persistence off-disk so a debounced flush never overwrites the staged
      // divergence mid-test.
      debounce: 300_000,
      maxDebounce: 600_000,
    });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterEach(async () => {
    vi.useRealTimers();
    await server.cleanup();
  });

  test('agent-write overwrite of un-propagated content trips the detector and checkpoints', async () => {
    const docName = `loss-agent-${crypto.randomUUID().slice(0, 8)}`;
    const created = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
    });
    expect(created.status).toBe(200);

    const state = getServerState(server, docName);
    const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
    stageUnpropagatedKeystroke(doc, state?.ytext as Y.Text, state?.fragment as Y.XmlFragment);

    // Public path: an agent REPLACE that rebuilds the fragment over the pending
    // keystroke — the write-surface spine threads the loss detector.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '## Guide\n\nIntro paragraph.\n\nReplaced body.\n',
        position: 'replace',
        docName,
      }),
    });
    expect(res.status).toBe(200);

    const trip = await pollForTrip(
      server.contentDir,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === 'agent-write-intake' &&
        e.docName === docName &&
        Boolean(e.checkpointSha),
    );
    expect(trip.direction).toBe('b');
    // At-risk bytes, not a type check: `lostLen: 0` means nothing was judged
    // lost, which is the outcome this test exists to rule out. Bound it by the
    // pending line the staging actually put at risk.
    expect(trip.lostLen).toBeGreaterThanOrEqual(PENDING_LINE.length);
    // Content-free ring: never the lost bytes.
    expect(JSON.stringify(trip)).not.toContain(PENDING_LINE);

    // The checkpoint is restorable through the ordinary history surface.
    const hist = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=${docName}`).then(
      (r) => r.json(),
    );
    const row = hist.entries.find(
      (e: { sha: string; checkpoint?: { kind?: string } }) => e.sha === trip.checkpointSha,
    );
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  });

  /**
   * The passive vector: nobody asked for a write. A `git pull` or an external
   * editor save lands on a doc that is OPEN and dirty, and the intake rebuilds
   * the fragment from the disk bytes over the un-propagated keystroke. Only the
   * booted rung observes it end to end — the reporter the file-watcher intake
   * receives is built inside `createServer` and handed to `applyToDoc`, so a
   * server-rung test that passes its OWN reporter into `applyExternalChange`
   * cannot tell whether that hand-off exists.
   *
   */
  test('an out-of-band disk edit over un-propagated content trips the detector and checkpoints', async () => {
    const docName = `loss-watcher-${crypto.randomUUID().slice(0, 8)}`;
    const created = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
    });
    expect(created.status).toBe(200);

    // The agent write forces its own flush, so the file is on disk and the
    // reconcile base points at it — the state a foreign edit diverges FROM.
    const filePath = join(server.contentDir, `${docName}.md`);
    await vi.waitFor(() => {
      expect(readFileSync(filePath, 'utf-8')).toContain('Step one bod');
    });
    // Let the watcher consume its own-write event for that flush first. Two
    // writes to one file inside a single watcher batch coalesce into ONE event,
    // and the coalesced event is classified against the FIRST write's hash —
    // the foreign edit below would be swallowed as a self-write.
    await new Promise((r) => setTimeout(r, 1_000));

    const state = getServerState(server, docName);
    const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
    const ytext = state?.ytext as Y.Text;
    const fragment = state?.fragment as Y.XmlFragment;
    stageUnpropagatedKeystroke(doc, ytext, fragment);

    // A foreign writer (git checkout, VS Code save) edits a DIFFERENT region of
    // the same file. The watcher's three-way merge reads `ours` from Y.Text, so
    // the pending fragment keystroke is not in the merged content and the
    // rebuild discards it.
    writeFileSync(
      filePath,
      GEN1.replace('Intro paragraph.', 'Intro paragraph, edited out of band.'),
      'utf-8',
    );
    // The window really was still open when the disk edit landed.
    expect(serializeFragment(fragment)).toContain(PENDING_LINE);
    expect(ytext.toString()).not.toContain(PENDING_LINE);

    const trip = await pollForTrip(
      server.contentDir,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === 'file-watcher-intake' &&
        e.docName === docName &&
        Boolean(e.checkpointSha),
      15_000,
    );
    expect(trip.direction).toBe('b');
    // The disk write is the writer of record, not the agent that opened the doc.
    expect(trip.writerId).toBe('file-system');
    expect(trip.lostLen).toBeGreaterThanOrEqual(PENDING_LINE.length);
    expect(JSON.stringify(trip)).not.toContain(PENDING_LINE);

    // Detection is not a veto: the disk edit still lands.
    await vi.waitFor(() => {
      expect(ytext.toString()).toContain('edited out of band');
    });

    // ...and the discarded keystroke is restorable through the ordinary
    // history surface, which is the whole point of checkpointing it.
    const hist = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=${docName}`).then(
      (r) => r.json(),
    );
    const row = hist.entries.find(
      (e: { sha: string; checkpoint?: { kind?: string } }) => e.sha === trip.checkpointSha,
    );
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  }, 30_000);
});
