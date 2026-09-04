import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { projectDigest, scopedStorageKey } from '../lib/storage-scope';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

vi.mock('./replay-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./replay-outbox')>();
  return {
    ...actual,
    readReplayOutboxEntry: vi.fn(actual.readReplayOutboxEntry),
    consumeReplayOutboxEntry: vi.fn(actual.consumeReplayOutboxEntry),
  };
});

const DUMMY_WS = 'ws://localhost:1/collab';

function uniqueDocName(): string {
  return `pp-durable-${randomUUID()}`;
}

function buildSourceOnlyState(text: string): { delta: Uint8Array; fullState: Uint8Array } {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, text);
  const fullState = Y.encodeStateAsUpdate(doc);
  const delta = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));
  doc.destroy();
  return { delta, fullState };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
}

let pool: ProviderPool;

afterEach(() => {
  pool?.dispose();
});

describe('ProviderPool durable replay outbox', () => {
  it('recovers an unsynced edit from the durable outbox on a fresh open', async () => {
    const docName = uniqueDocName();
    const marker = `durable-recovered-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('does not re-apply after a completed recovery (exactly-once across reopen)', async () => {
    const docName = uniqueDocName();
    const marker = `once-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });
    await waitFor(() => entry.provider.document.getText('source').toString().includes(marker));
    pool.dispose();

    pool = new ProviderPool(3, DUMMY_WS);
    const entry2 = pool.open(docName);
    if (!entry2) throw new Error('expected entry2');
    entry2.observerCleanup = () => {};
    entry2.provider.emit('synced', { state: true });
    await wait(80);
    expect(entry2.provider.document.getText('source').toString()).toBe('');
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('a second `synced` never re-enters the replay', async () => {
    const docName = uniqueDocName();
    const marker = `single-fire-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};

    vi.mocked(readReplayOutboxEntry).mockClear();

    entry.provider.emit('synced', { state: true });
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
    await wait(80);

    expect(vi.mocked(readReplayOutboxEntry)).toHaveBeenCalledTimes(1);
    expect(entry.provider.document.getText('source').toString()).toBe(marker);
  });

  it('consumes the outbox and does not crash on a corrupt buffer', async () => {
    const docName = uniqueDocName();
    const real = buildSourceOnlyState('some real content that will be truncated');
    const truncated = real.fullState.slice(0, 4);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: null },
      {
        delta: truncated,
        fullState: truncated,
      },
    );

    pool = new ProviderPool(3, DUMMY_WS);
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    let consumed = false;
    for (let i = 0; i < 60 && !consumed; i += 1) {
      consumed =
        (await readReplayOutboxEntry({
          branch: UNKNOWN_BRANCH_SENTINEL,
          docName,
          namespace: null,
        })) === null;
      if (!consumed) await wait(10);
    }
    expect(consumed).toBe(true);
    expect(entry.provider.document.getText('source').toString()).toBe('');
  });
});

describe('ProviderPool durable replay outbox project scoping', () => {
  const PROJECT_A = '/Users/dev/repo/.worktrees/a';
  const PROJECT_B = '/Users/dev/repo/.worktrees/b';

  it("recovers an edit written under the pool's own project namespace", async () => {
    const docName = uniqueDocName();
    const marker = `scoped-recovered-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: PROJECT_A },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
  });

  it("never touches a sibling project's buffered edit", async () => {
    const docName = uniqueDocName();
    const marker = `sibling-only-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: PROJECT_A },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_B });
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    vi.mocked(readReplayOutboxEntry).mockClear();
    entry.provider.emit('synced', { state: true });

    const replayRan = await waitFor(() =>
      vi
        .mocked(readReplayOutboxEntry)
        .mock.calls.some(([key]) => key.docName === docName && key.namespace === PROJECT_B),
    );
    expect(replayRan).toBe(true);

    expect(entry.provider.document.getText('source').toString()).not.toContain(marker);
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: PROJECT_A,
      }),
    ).not.toBeNull();
  });

  it('writes the outbox under the pool project namespace on a mismatch recycle', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    pool.setExpectedServerInstanceId('durable-scoped-epoch');
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.setActive(docName);
    entry.provider.emit('synced', { state: true });
    entry.provider.document.getText('source').insert(0, `parked-${randomUUID()}`);

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await pool.awaitMismatchSettled();

    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: PROJECT_A,
      }),
    ).not.toBeNull();
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('discards the outbox under the pool project namespace on close()', async () => {
    const docName = uniqueDocName();
    const marker = `discard-scoped-${randomUUID()}`;
    const { delta, fullState } = buildSourceOnlyState(marker);
    await writeReplayOutboxEntry(
      { branch: UNKNOWN_BRANCH_SENTINEL, docName, namespace: PROJECT_A },
      { delta, fullState },
    );

    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.__test_seedBufferedUpdate(docName, delta, {
      fullState,
      durable: true,
      branch: UNKNOWN_BRANCH_SENTINEL,
    });

    pool.close(docName);

    await vi.waitFor(async () => {
      expect(
        await readReplayOutboxEntry({
          branch: UNKNOWN_BRANCH_SENTINEL,
          docName,
          namespace: PROJECT_A,
        }),
      ).toBeNull();
    });
  });

  it('emits recovery telemetry carrying the project as a digest, not a path', async () => {
    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    pool.setExpectedServerInstanceId('telemetry-scoped-epoch');
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.setActive(docName);

    const warned: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      if (typeof line === 'string') warned.push(line);
    });
    try {
      entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
      await pool.awaitMismatchSettled();
    } finally {
      warnSpy.mockRestore();
    }

    const events = warned
      .filter((line) => line.includes('ok-buffer-replay-skipped'))
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(events.length).toBeGreaterThan(0);

    const event = events[0] as Record<string, string>;
    expect(event.project).toBe(projectDigest(PROJECT_A));
    expect(event.project).not.toContain('/');
    expect(event.project).not.toBe(PROJECT_A);
    expect(scopedStorageKey('ok-replay-outbox', PROJECT_A)).toBe(
      `ok-replay-outbox:${event.project}`,
    );
  });
});
