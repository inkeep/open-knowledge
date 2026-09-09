import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ProviderPool } from './provider-pool';

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-silence-${randomUUID()}`;
}

function buildSourceOnlyState(text: string): { delta: Uint8Array; fullState: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, text);
  const fullState = Y.encodeStateAsUpdate(doc);
  const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
  doc.destroy();
  return { delta, fullState };
}

function emitted(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.flatMap(([first]) => {
    if (typeof first !== 'string') return [];
    try {
      return [JSON.parse(first) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function eventNamed(
  spy: ReturnType<typeof vi.spyOn>,
  name: string,
): Record<string, unknown> | undefined {
  return emitted(spy).find((parsed) => parsed.event === name);
}

let pool: ProviderPool;
let warn: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  pool?.dispose();
  warn?.mockRestore();
});

describe('ProviderPool replay — every return names itself', () => {
  it('names the empty outbox when a synced provider has nothing to replay', async () => {
    const docName = uniqueDocName();
    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};

    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(eventNamed(warn, 'ok-buffer-replay-outbox-empty')).toBeDefined();
    });
    expect(eventNamed(warn, 'ok-buffer-replay-outbox-empty')).toMatchObject({
      docName,
      reason: 'no-buffer-and-no-outbox-entry',
    });
  });

  it('names a raw delta applied because no full state was captured', async () => {
    const docName = uniqueDocName();
    const marker = `no-full-state-${randomUUID()}`;
    const { delta } = buildSourceOnlyState(marker);

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta);

    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(eventNamed(warn, 'ok-buffer-replay-content-skipped')).toBeDefined();
    });
    expect(eventNamed(warn, 'ok-buffer-replay-content-skipped')).toMatchObject({
      docName,
      reason: 'no-full-state-captured',
      replayByteLength: delta.byteLength,
    });
    expect(entry.provider.document.getText('source').toString()).toContain(marker);
  });

  it('names a raw delta applied after the content replay refused the buffer', async () => {
    const docName = uniqueDocName();
    const marker = `refused-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, { fullState });

    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(eventNamed(warn, 'ok-buffer-replay-content-skipped')).toBeDefined();
    });
    expect(eventNamed(warn, 'ok-buffer-replay-diverged')).toBeDefined();
    expect(eventNamed(warn, 'ok-buffer-replay-content-skipped')).toMatchObject({
      docName,
      reason: 'content-replay-refused',
      replayByteLength: delta.byteLength,
    });
  });

  it('CHARACTERIZATION: closing a document destroys the buffered edit and its durable row', async () => {
    const docName = uniqueDocName();
    const marker = `closed-away-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, durable: true });

    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pool.close(docName);

    expect(eventNamed(warn, 'ok-buffer-replay-discarded')).toMatchObject({
      docName,
      via: 'pool-close',
      durable: 'yes',
      replayByteLength: delta.byteLength,
    });
    expect(pool.__test_bufferedUpdatesSize()).toBe(0);
  });

  it('names the buffer that the server already carries, instead of returning silently', async () => {
    const docName = uniqueDocName();
    const settled = `# Notes\n\nAlready on the server ${randomUUID()}.\n`;
    const { delta, fullState } = buildSourceOnlyState(settled);

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.document.getText('source').insert(0, settled);
    pool.__test_seedBufferedUpdate(docName, delta, { fullState, base: settled });

    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    entry.provider.emit('synced', { state: true });

    await vi.waitFor(() => {
      expect(eventNamed(warn, 'ok-buffer-replay-content-noop')).toBeDefined();
    });
    expect(eventNamed(warn, 'ok-buffer-replay-content-noop')).toMatchObject({
      docName,
      reason: 'buffered-state-already-matches-server',
    });
  });
});
