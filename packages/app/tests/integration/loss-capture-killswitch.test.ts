/**
 * Behavioral kill-switch coverage for the loss-capture ring through the REAL
 * boot path: `.ok/config.yml` (`lossCapture.enabled`) → `createServer` builds
 * (or, when disabled, does NOT build) the ring → producers write (or write to a
 * nothing).
 *
 * The loss producer is the derive-timing defer guard (it records a `guard-defer`
 * event on every defer), staged on the booted server's own Y.Doc exactly like
 * the derive-timing full-flow rig: a freshness-suppressed Observer A settlement
 * leaves the fragment ahead of Y.Text, then a source-editor write drives an
 * Observer B re-derive the guard defers. Only `Date` is faked so the real WS +
 * async I/O proceed.
 *
 * ON: the default config builds the ring, so the defer lands a content-free
 * `guard-defer` event under `.ok/local/loss-capture/`. OFF: with
 * `lossCapture.enabled: false` the ring is never built — the guard still defers
 * (its own kill-switch is untouched, so the keystroke still survives) but records
 * nothing. The contrast isolates the ring kill-switch from the producer.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema, type JSONContent } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, getServerState, mdManager, type TestServer } from './test-harness.ts';

const schema = getSchema(sharedExtensions);
// The server serializes freshness-ON (its md-manager singleton); the harness
// `mdManager` is freshness-OFF, so verify the fragment with a matching engine.
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
const PENDING_LINE = 'Step one body.';
const GUARD_DEFER_EVENT = 'guard-defer';

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
function readLossEvents(contentDir: string): Array<{ event: string; docName: string }> {
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
          return [JSON.parse(line) as { event: string; docName: string }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The append is async (RotatingAppender FIFO), so the ON arm polls for it. The
 * OFF arm's "nothing was written" must wait AT LEAST as long as the ON arm is
 * willing to wait — a shorter negative window proves only that the write had
 * not landed yet.
 */
const RING_POLL_ATTEMPTS = 40;
const RING_POLL_INTERVAL_MS = 50;
const RING_WAIT_BUDGET_MS = RING_POLL_ATTEMPTS * RING_POLL_INTERVAL_MS;

/** The ring's on-disk file, whether or not it was ever built. */
function ringPath(contentDir: string): string {
  return join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl');
}

/**
 * Stage the derive-timing defer on the booted server's own doc and assert the
 * guard deferred (the keystroke survives). The defer is the loss producer under
 * test.
 */
async function stageGuardDefer(server: TestServer, docName: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
  });
  expect(res.status).toBe(200);

  const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
  expect(doc).toBeTruthy();
  const state = getServerState(server, docName);
  expect(state?.ytext.toString()).toContain(STALE_LINE);
  const ytext = state?.ytext as Y.Text;
  const fragment = state?.fragment as Y.XmlFragment;

  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);

  // Reset the freshness-quiescence clock, then advance the component children
  // while sourceRaw stays stale so Observer A settles ahead of Y.Text.
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

  // Source write → Observer B re-derive the guard defers (keystroke survives).
  doc.transact(() => {
    ytext.insert(ytext.length, '\nAnother source line.\n');
  }, 'external-peer');
  expect(serializeFragment(fragment)).toContain(PENDING_LINE);

  // Restore real time so the async ring append (RotatingAppender FIFO) can be
  // polled off disk without the faked clock in the way.
  vi.useRealTimers();
}

describe('loss-capture ring — kill-switch behavioral pair', () => {
  const owned: Array<{ server: TestServer; contentDir?: string }> = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const { server, contentDir } of owned.splice(0)) {
      await server.cleanup();
      if (contentDir) rmSync(contentDir, { recursive: true, force: true });
    }
  });

  test(
    'ON (default): a defer lands a content-free guard-defer event in the ring',
    async () => {
      const server = await createTestServer();
      owned.push({ server });
      const docName = `ring-on-${crypto.randomUUID().slice(0, 8)}`;
      await stageGuardDefer(server, docName);

      // Poll the ring off disk — the append is async (FIFO through the appender).
      let events = readLossEvents(server.contentDir);
      let elapsedMs = 0;
      for (
        let i = 0;
        i < RING_POLL_ATTEMPTS && !events.some((e) => e.event === GUARD_DEFER_EVENT);
        i++
      ) {
        await sleep(RING_POLL_INTERVAL_MS);
        elapsedMs += RING_POLL_INTERVAL_MS;
        events = readLossEvents(server.contentDir);
      }
      const deferEvents = events.filter((e) => e.event === GUARD_DEFER_EVENT);
      expect(deferEvents.length).toBeGreaterThan(0);
      expect(deferEvents[0]?.docName).toBe(docName);
      // The observed latency of the write the OFF arm has to out-wait. Kept as
      // an assertion so a regression that pushes the append past the shared
      // budget shows up here rather than as a silent OFF-arm false negative.
      expect(elapsedMs).toBeLessThan(RING_WAIT_BUDGET_MS);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'OFF (lossCapture.enabled: false): the guard still defers but the ring records nothing',
    async () => {
      // Self-seed a contentDir whose config disables the ring, then boot on it.
      const contentDir = mkdtempSync(join(tmpdir(), 'ok-ring-off-'));
      mkdirSync(join(contentDir, '.ok'), { recursive: true });
      writeFileSync(
        join(contentDir, '.ok', 'config.yml'),
        'lossCapture:\n  enabled: false\n',
        'utf-8',
      );
      writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');

      const server = await createTestServer({ contentDir, keepContentDir: true });
      owned.push({ server, contentDir: server.contentDir });
      const docName = `ring-off-${crypto.randomUUID().slice(0, 8)}`;
      await stageGuardDefer(server, docName);

      // The producer fired (keystroke survived, asserted in stageGuardDefer), but
      // with the ring disabled no event is ever written. Two oracles:
      //
      // (1) Structural, timing-free — the ring was never BUILT, so its file does
      //     not exist. Nothing about this can be satisfied by an append that is
      //     merely still in flight.
      expect(existsSync(ringPath(server.contentDir))).toBe(false);

      // (2) Temporal — out-wait the full budget the ON arm is willing to poll
      //     for, so "empty" cannot mean "not yet".
      await sleep(RING_WAIT_BUDGET_MS);
      expect(existsSync(ringPath(server.contentDir))).toBe(false);
      const deferEvents = readLossEvents(server.contentDir).filter(
        (e) => e.event === GUARD_DEFER_EVENT,
      );
      expect(deferEvents).toEqual([]);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );
});
