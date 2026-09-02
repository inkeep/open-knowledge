import { randomUUID } from 'node:crypto';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared.ts';
import { ProviderPool } from './provider-pool';

const DUMMY_WS = 'ws://localhost:1/collab';
const schema = getSchema(sharedExtensions);
const mdManager = new MarkdownManager({ extensions: sharedExtensions });

const BASE_MD = '# Notes\n\nSettled paragraph.\n';
const BUFFERED_MD = '# Notes\n\nSettled paragraph.\n\nUnsynced source-mode line.\n';
const BUFFERED_MARKER = 'Unsynced source-mode line.';
const MOVED_MD = '# Notes\n\nA different paragraph, authored elsewhere.\n';
const MOVED_MARKER = 'authored elsewhere';

function buildTwoSurfaceState(
  baseMd: string,
  editedMd: string,
): { delta: Uint8Array; fullState: Uint8Array } {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getText('source').insert(0, editedMd);
    updateYFragment(
      doc,
      doc.getXmlFragment('default'),
      schema.nodeFromJSON(mdManager.parse(baseMd)),
      {
        mapping: new Map(),
        isOMark: new Map(),
      },
    );
  });
  const fullState = Y.encodeStateAsUpdate(doc);
  const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
  doc.destroy();
  return { delta, fullState };
}

function emittedEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.flatMap(([first]) => {
    if (typeof first !== 'string') return [];
    try {
      const parsed = JSON.parse(first) as { event?: unknown };
      return typeof parsed.event === 'string' ? [parsed.event] : [];
    } catch {
      return [];
    }
  });
}

let pool: ProviderPool;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

function replaySettled(): boolean {
  const seen = [...emittedEvents(warn), ...emittedEvents(info)];
  return (
    seen.includes('ok-buffer-replay-content-applied') ||
    seen.includes('ok-pool-buffer-replay-delta-applied')
  );
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  pool?.dispose();
  vi.restoreAllMocks();
});

function armReplay(serverContent: string): { docName: string; ytext: Y.Text } {
  const docName = `pp-diverged-${randomUUID()}`;
  const { delta, fullState } = buildTwoSurfaceState(BASE_MD, BUFFERED_MD);
  pool = new ProviderPool(3, DUMMY_WS);
  const entry = pool.open(docName);
  if (!entry) throw new Error('expected entry');
  entry.observerCleanup = () => {};
  const ytext = entry.provider.document.getText('source');
  ytext.insert(0, serverContent);
  pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });
  entry.provider.emit('synced', { state: true });
  return { docName, ytext };
}

describe('content-level replay against content the server has moved past', () => {
  it('refuses the splice and reports the divergence', async () => {
    const { ytext } = armReplay(MOVED_MD);

    await vi.waitFor(() => {
      expect(replaySettled()).toBe(true);
    });

    expect(ytext.toString()).toContain(MOVED_MARKER);
    expect(emittedEvents(warn)).toContain('ok-buffer-replay-diverged');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-content-applied');
    expect(emittedEvents(info)).toContain('ok-pool-buffer-replay-delta-applied');
  });

  it('splices the same buffer when the server content has NOT moved', async () => {
    const { ytext } = armReplay(BASE_MD);

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain(BUFFERED_MARKER);
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });
});

describe('content-level replay of an edit the comparator cannot see', () => {
  const BLANK_RUN_MD = '# Notes\n\n\n\nSettled paragraph.\n';

  it('recovers buffered blank lines the server state lacks', async () => {
    const docName = `pp-blank-${randomUUID()}`;
    const { delta, fullState } = buildTwoSurfaceState(BASE_MD, BLANK_RUN_MD);
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    const ytext = entry.provider.document.getText('source');
    ytext.insert(0, BASE_MD);
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: false });
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(emittedEvents(warn)).toContain('ok-buffer-replay-content-applied');
    });
    expect(ytext.toString()).toContain('# Notes\n\n\n\nSettled paragraph.');
    expect(emittedEvents(warn)).not.toContain('ok-buffer-replay-diverged');
  });
});
