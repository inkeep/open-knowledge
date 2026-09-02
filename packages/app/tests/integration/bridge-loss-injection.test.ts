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
const freshMdManager = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const STALE_LINE = 'Step one bod';
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

function serializeFragment(fragment: Y.XmlFragment): string {
  return freshMdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

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
    expect(trip.lostLen).toBeGreaterThanOrEqual(PENDING_LINE.length);
    expect(JSON.stringify(trip)).not.toContain(PENDING_LINE);

    const hist = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=${docName}`).then(
      (r) => r.json(),
    );
    const row = hist.entries.find(
      (e: { sha: string; checkpoint?: { kind?: string } }) => e.sha === trip.checkpointSha,
    );
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  });

  test('an out-of-band disk edit over un-propagated content trips the detector and checkpoints', async () => {
    const docName = `loss-watcher-${crypto.randomUUID().slice(0, 8)}`;
    const created = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: GEN1, position: 'replace', docName }),
    });
    expect(created.status).toBe(200);

    const filePath = join(server.contentDir, `${docName}.md`);
    await vi.waitFor(() => {
      expect(readFileSync(filePath, 'utf-8')).toContain('Step one bod');
    });
    await new Promise((r) => setTimeout(r, 1_000));

    const state = getServerState(server, docName);
    const doc = server.instance.hocuspocus.documents.get(docName) as unknown as Y.Doc;
    const ytext = state?.ytext as Y.Text;
    const fragment = state?.fragment as Y.XmlFragment;
    stageUnpropagatedKeystroke(doc, ytext, fragment);

    writeFileSync(
      filePath,
      GEN1.replace('Intro paragraph.', 'Intro paragraph, edited out of band.'),
      'utf-8',
    );
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
    expect(trip.writerId).toBe('file-system');
    expect(trip.lostLen).toBeGreaterThanOrEqual(PENDING_LINE.length);
    expect(JSON.stringify(trip)).not.toContain(PENDING_LINE);

    await vi.waitFor(() => {
      expect(ytext.toString()).toContain('edited out of band');
    });

    const hist = await fetch(`http://127.0.0.1:${server.port}/api/history?docName=${docName}`).then(
      (r) => r.json(),
    );
    const row = hist.entries.find(
      (e: { sha: string; checkpoint?: { kind?: string } }) => e.sha === trip.checkpointSha,
    );
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  }, 30_000);
});
