/**
 * Unit tests for durable replay-outbox recovery in ProviderPool.
 *
 * These construct a real HocuspocusProvider against a dead URL (never
 * connects) and drive the replay listener via a synthetic `synced` emit,
 * against the globally-installed `fake-indexeddb`. They cover the reopen path:
 * a fresh tab (no in-memory buffer) recovers an unsynced edit from the durable
 * outbox, consumes it before applying (so a reopen never re-applies), and
 * never crashes on a corrupt buffer.
 *
 * The content-level replay against a REAL server (Observer B derive, real
 * `theirs` comparison) is exercised in
 * `tests/integration/replay-outbox-durable.test.ts`.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { projectDigest, scopedStorageKey } from '../lib/storage-scope';
import { UNKNOWN_BRANCH_SENTINEL } from './client-persistence';
import { ProviderPool } from './provider-pool';
import { readReplayOutboxEntry, writeReplayOutboxEntry } from './replay-outbox';

// Spy-wrap the REAL outbox module (no behavior change) so the replay
// listener's own invocation count is observable. Its first act on a fresh tab
// is the outbox read, which makes that count the direct reading of "how many
// times did the replay run".
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

/**
 * Build a source-only pre-recycle state: an unsynced edit lives in
 * `Y.Text('source')`, the XML fragment is empty. Against an empty fresh doc
 * (the unit tier's dead-URL provider), the content-level replay's fragment-
 * clean branch splices the recovered source in.
 */
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
    // Consume-first: the durable outbox is gone after recovery.
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

    // A second fresh tab: the outbox was consumed, so no replay fires and the
    // fresh doc stays empty — the recovered content is NOT re-inserted.
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

    // A reconnect can re-emit `synced` while the first replay is still inside
    // its awaits — the record is not consumed yet, so a second entrant would
    // read the SAME buffer and race the consume the design exists to make
    // single-fire. The listener detaches itself synchronously before the first
    // await for exactly this reason; both emits land in that window.
    entry.provider.emit('synced', { state: true });
    entry.provider.emit('synced', { state: true });

    const recovered = await waitFor(() =>
      entry.provider.document.getText('source').toString().includes(marker),
    );
    expect(recovered).toBe(true);
    await wait(80);

    expect(vi.mocked(readReplayOutboxEntry)).toHaveBeenCalledTimes(1);
    // And the user-visible outcome: one copy of the recovered edit.
    expect(entry.provider.document.getText('source').toString()).toBe(marker);
  });

  it('consumes the outbox and does not crash on a corrupt buffer', async () => {
    const docName = uniqueDocName();
    // Valid record shape, but a truncated Yjs update — the guarded apply must
    // not crash the client, and the outbox is consumed before the apply is
    // attempted (consume-first) so it can never re-fire.
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

    // The outbox is consumed regardless of the apply outcome (consume-first).
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
    // No meaningful content was fabricated from the corrupt bytes.
    expect(entry.provider.document.getText('source').toString()).toBe('');
  });
});

/**
 * Wiring tests: the pool must hand its project identity to every outbox call.
 *
 * The outbox module's own tests prove a namespaced database name isolates
 * projects. These prove the pool actually SUPPLIES that namespace — a call
 * site that passed `null` (or another project's value) would leave those
 * module tests green while restoring the collision.
 */
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
    // Project A has an unsynced edit parked in its outbox. A window of
    // project B opens the same repo-relative path on the same branch.
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

    // Wait on a POSITIVE signal that B's replay actually ran — its first act
    // is the outbox read. Waiting only for "no leak yet" would also pass for a
    // replay that is merely slow, which is the bug wearing a stopwatch.
    const replayRan = await waitFor(() =>
      vi
        .mocked(readReplayOutboxEntry)
        .mock.calls.some(([key]) => key.docName === docName && key.namespace === PROJECT_B),
    );
    expect(replayRan).toBe(true);

    // Having run, B found nothing of its own: it neither applied A's content...
    expect(entry.provider.document.getText('source').toString()).not.toContain(marker);
    // ...nor consumed A's record, which A still needs on its next open.
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: PROJECT_A,
      }),
    ).not.toBeNull();
  });

  it('writes the outbox under the pool project namespace on a mismatch recycle', async () => {
    // Covers the WRITE site, the only one that plants content. The tests above
    // cover the read and the RECOVERY-path consume; the discard-path consume
    // is a distinct site covered by its own test below.
    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    pool.setExpectedServerInstanceId('durable-scoped-epoch');
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.setActive(docName);
    // `synced` is what captures the baseline state vector. The edit has to
    // land AFTER it, or the delta is empty and the recycle skips the capture
    // as unreplayable ("no-disk-ack-or-server-sync-vector").
    entry.provider.emit('synced', { state: true });
    entry.provider.document.getText('source').insert(0, `parked-${randomUUID()}`);

    entry.provider.emit('authenticationFailed', { reason: 'server-instance-mismatch' });
    await pool.awaitMismatchSettled();

    // The record lands under THIS project's name...
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: PROJECT_A,
      }),
    ).not.toBeNull();
    // ...and NOT under the app-wide name that a `null` at the call site would
    // produce. This assertion is what makes the write site's namespace
    // load-bearing rather than merely present.
    expect(
      await readReplayOutboxEntry({
        branch: UNKNOWN_BRANCH_SENTINEL,
        docName,
        namespace: null,
      }),
    ).toBeNull();
  });

  it('discards the outbox under the pool project namespace on close()', async () => {
    // The fourth call site: `discardBufferedUpdate`'s consume. A `null` here
    // targets the unscoped database, finds nothing, and leaves the REAL record
    // in place — so the next open resurrects an edit the user discarded. That
    // is silent content resurrection, the same class this scoping closes.
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
    // Two properties in one: the field is PRESENT (so a cross-project report
    // has something to correlate on), and it is the DIGEST. Dropping the
    // digest call still type-checks, and these events reach `~/.ok/logs` and
    // bug-report bundles, so a raw namespace here would ship home-directory
    // paths. The value must also equal the segment `scopedStorageKey` embeds,
    // or correlating an event to its database silently matches nothing.
    pool = new ProviderPool(3, DUMMY_WS, { storageNamespace: PROJECT_A });
    pool.setExpectedServerInstanceId('telemetry-scoped-epoch');
    const docName = uniqueDocName();
    const entry = pool.open(docName);
    if (!entry) throw new Error('expected entry');
    entry.observerCleanup = () => {};
    pool.setActive(docName);

    // `spyOn` + `finally` rather than a raw reassign: this stub window
    // contains an `await`, so a rejection would otherwise leave `console.warn`
    // pointed at a dead spy for the rest of the worker. Accumulate into a
    // local rather than reading `mock.calls` afterwards — `mockRestore` clears
    // the call history along with the implementation.
    const warned: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      if (typeof line === 'string') warned.push(line);
    });
    try {
      // No `synced`, so no baseline vector: the recycle takes the
      // skipped-no-baseline arm, which emits through `recoveryTelemetryBase`.
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
    // Belt and braces on the privacy half: a digest carries no path separator.
    expect(event.project).not.toContain('/');
    expect(event.project).not.toBe(PROJECT_A);
    // The correlation half, which sharing `projectDigest` alone does NOT buy:
    // the callers agree by construction, but the COMPOSITION that turns a
    // digest into a name segment lives in `scopedStorageKey`. Change it (a
    // salt, a truncation, a version prefix) and the assertions above still
    // pass while correlating an event to its database matches nothing.
    expect(scopedStorageKey('ok-replay-outbox', PROJECT_A)).toBe(
      `ok-replay-outbox:${event.project}`,
    );
  });
});
