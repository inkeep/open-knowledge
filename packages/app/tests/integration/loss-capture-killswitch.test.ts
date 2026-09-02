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

function serializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

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

const RING_POLL_ATTEMPTS = 40;
const RING_POLL_INTERVAL_MS = 50;
const RING_WAIT_BUDGET_MS = RING_POLL_ATTEMPTS * RING_POLL_INTERVAL_MS;

function ringPath(contentDir: string): string {
  return join(contentDir, '.ok', 'local', 'loss-capture', 'loss-current.jsonl');
}

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

  doc.transact(() => {
    ytext.insert(ytext.length, '\nAnother source line.\n');
  }, 'external-peer');
  expect(serializeFragment(fragment)).toContain(PENDING_LINE);

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
      expect(elapsedMs).toBeLessThan(RING_WAIT_BUDGET_MS);
    },
    HARNESS_BOOT_TIMEOUT_MS,
  );

  test(
    'OFF (lossCapture.enabled: false): the guard still defers but the ring records nothing',
    async () => {
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

      expect(existsSync(ringPath(server.contentDir))).toBe(false);

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
