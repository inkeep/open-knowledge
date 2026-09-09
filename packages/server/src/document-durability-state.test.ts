import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  _resetDocExtensionsForTests,
  docNameToRelativePath,
  isRegisteredMarkdownDocName,
  registerDocExtension,
} from './doc-extensions.ts';
import {
  DISPLACED_VERSION_LIMIT,
  DISPLACED_VERSION_TTL_MS,
  DocumentDurabilityState,
  DocumentDurabilityStateError,
} from './document-durability-state.ts';
import * as tracedFs from './fs-traced.ts';
import { getLogger } from './logger.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

describe('DocumentDurabilityState', () => {
  test('starts with an empty main scope and no transient coordination state', () => {
    const state = new DocumentDurabilityState();

    expect(state.getActiveBranch()).toBe('main');
    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
    expect(state.isBatchInProgress()).toBe(false);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toBeNull();
    expect(state.takeStoreDivergence('doc')).toBe(false);
  });

  test('retains reconciled bases independently for each visited branch', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    state.setReconciledBase('doc', 'feature bytes');

    expect(state.getReconciledBase('doc')).toBe('feature bytes');
    state.switchReconciledBaseScope('main');
    expect(state.getReconciledBase('doc')).toBe('main bytes');
  });

  test('deletes a reconciled base only from the active branch', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'main bytes');
    state.switchReconciledBaseScope('feature');
    state.setReconciledBase('doc', 'feature bytes');

    state.switchReconciledBaseScope('main');
    state.deleteReconciledBase('doc');
    expect(state.getReconciledBase('doc')).toBeUndefined();
    state.switchReconciledBaseScope('feature');
    expect(state.getReconciledBase('doc')).toBe('feature bytes');
  });

  test('isolates every owned coordination channel between instances', () => {
    const first = new DocumentDurabilityState();
    const second = new DocumentDurabilityState();
    first.setReconciledBase('doc', 'first');
    first.setBatchInProgress(true);
    first.beginInFlightFlush('doc', 'first flush');
    first.markAgentWriteStore('doc');
    first.recordStoreFailure('doc', { code: 'ENOSPC', message: 'full' });
    first.recordStoreDivergence('doc');

    expect(second.getReconciledBase('doc')).toBeUndefined();
    expect(second.isBatchInProgress()).toBe(false);
    expect(second.peekInFlightFlush('doc')).toBeUndefined();
    expect(second.consumeAgentWriteStore('doc')).toBe(false);
    expect(second.takeStoreFailure('doc')).toBeNull();
    expect(second.takeStoreDivergence('doc')).toBe(false);
  });

  test('does not let an older flush clear a newer in-flight snapshot', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'older');
    state.beginInFlightFlush('doc', 'newer');
    state.finishInFlightFlush('doc', 'older');
    expect(state.peekInFlightFlush('doc')).toBe('newer');
    state.finishInFlightFlush('doc', 'newer');
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
  });

  test('consumes agent markers, failures, and divergences once', () => {
    const state = new DocumentDurabilityState();
    state.markAgentWriteStore('doc');
    state.recordStoreFailure('doc', { message: 'write failed' });
    state.recordStoreDivergence('doc');

    expect(state.consumeAgentWriteStore('doc')).toBe(true);
    expect(state.consumeAgentWriteStore('doc')).toBe(false);
    expect(state.takeStoreFailure('doc')).toEqual({ message: 'write failed' });
    expect(state.takeStoreFailure('doc')).toBeNull();
    expect(state.takeStoreDivergence('doc')).toBe(true);
    expect(state.takeStoreDivergence('doc')).toBe(false);
  });

  test('clears a store failure without consuming another document failure', () => {
    const state = new DocumentDurabilityState();
    state.recordStoreFailure('cleared', { code: 'ENOSPC', message: 'full' });
    state.recordStoreFailure('retained', { message: 'readonly' });

    state.clearStoreFailure('cleared');
    expect(state.takeStoreFailure('cleared')).toBeNull();
    expect(state.takeStoreFailure('retained')).toEqual({ message: 'readonly' });
  });
});

describe('in-flight flush queue semantics', () => {
  test('finishing one of two identical snapshots leaves the other pending', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'same');
    state.beginInFlightFlush('doc', 'same');
    state.finishInFlightFlush('doc', 'same');
    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'same')).toBe(true);
    state.finishInFlightFlush('doc', 'same');
    expect(state.peekInFlightFlush('doc')).toBeUndefined();
    expect(state.inFlightFlushCount('doc')).toBe(0);
  });

  test('finishing a snapshot that was never begun leaves the queue untouched', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'real');
    state.finishInFlightFlush('doc', 'never-begun');
    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'real')).toBe(true);
  });

  test('a middle entry can finish out of order without disturbing its neighbours', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'a');
    state.beginInFlightFlush('doc', 'b');
    state.beginInFlightFlush('doc', 'c');
    state.finishInFlightFlush('doc', 'b');
    expect(state.hasInFlightFlush('doc', 'a')).toBe(true);
    expect(state.hasInFlightFlush('doc', 'b')).toBe(false);
    expect(state.hasInFlightFlush('doc', 'c')).toBe(true);
    expect(state.peekInFlightFlush('doc')).toBe('c');
  });

  test('content absent from a populated queue does not match', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'a');
    state.beginInFlightFlush('doc', 'b');
    expect(state.hasInFlightFlush('doc', 'absent')).toBe(false);
    expect(state.hasInFlightFlush('other-doc', 'a')).toBe(false);
  });

  test('a leaked entry expires on read, with no later flush needed to sweep it', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'leaked');
      expect(state.peekInFlightFlush('doc')).toBe('leaked');

      vi.advanceTimersByTime(61_000);

      expect(state.peekInFlightFlush('doc')).toBeUndefined();
      expect(state.inFlightFlushCount('doc')).toBe(0);
      expect(state.hasInFlightFlush('doc', 'leaked')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('deleting a doc clears its in-flight flush records alongside its reconciled base', () => {
    const state = new DocumentDurabilityState();
    state.setReconciledBase('doc', 'base');
    state.beginInFlightFlush('doc', 'pending');
    state.beginInFlightFlush('other', 'pending');

    state.deleteReconciledBase('doc');

    expect(state.getReconciledBase('doc')).toBeUndefined();
    expect(state.inFlightFlushCount('doc')).toBe(0);
    expect(state.inFlightFlushCount('other')).toBe(1);
  });

  test('switching branch scope leaves in-flight flush records alone, since a write in flight is not branch-scoped', () => {
    const state = new DocumentDurabilityState();
    state.beginInFlightFlush('doc', 'pending');

    state.switchReconciledBaseScope('feature');

    expect(state.inFlightFlushCount('doc')).toBe(1);
    expect(state.hasInFlightFlush('doc', 'pending')).toBe(true);
  });

  test('the expiry counter reports how many records were dropped, not how many prunes ran', () => {
    vi.useFakeTimers();
    try {
      resetMetrics();
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'first');
      state.beginInFlightFlush('doc', 'second');

      vi.advanceTimersByTime(61_000);
      expect(state.inFlightFlushCount('doc')).toBe(0);

      expect(getMetrics().inFlightFlushExpired).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a stale entry is also discarded when the next flush for the same document begins', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'leaked');
      vi.advanceTimersByTime(61_000);
      state.beginInFlightFlush('doc', 'fresh');

      expect(state.hasInFlightFlush('doc', 'leaked')).toBe(false);
      expect(state.inFlightFlushCount('doc')).toBe(1);
      state.finishInFlightFlush('doc', 'fresh');
      expect(state.peekInFlightFlush('doc')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a flush still in flight is not aged out while it keeps company with newer flushes', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.beginInFlightFlush('doc', 'slow');
      vi.advanceTimersByTime(5_000);
      state.beginInFlightFlush('doc', 'quick');
      expect(state.hasInFlightFlush('doc', 'slow')).toBe(true);
      expect(state.inFlightFlushCount('doc')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('displaced-version history', () => {
  test('recognizes a version this server displaced and ignores one it never wrote', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'v1 bytes');

    expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(true);
    expect(state.isDisplacedVersion('doc', 'never written')).toBe(false);
    expect(state.isDisplacedVersion('other-doc', 'v1 bytes')).toBe(false);
  });

  test('retains only the newest DISPLACED_VERSION_LIMIT versions per document', () => {
    const state = new DocumentDurabilityState();
    for (let i = 0; i <= DISPLACED_VERSION_LIMIT; i++) {
      state.recordDisplacedVersion('doc', `v${i}`);
    }

    expect(state.isDisplacedVersion('doc', 'v0')).toBe(false);
    expect(state.isDisplacedVersion('doc', 'v1')).toBe(true);
    expect(state.isDisplacedVersion('doc', `v${DISPLACED_VERSION_LIMIT}`)).toBe(true);
  });

  test('a re-displaced version refreshes in place instead of consuming another slot', () => {
    const state = new DocumentDurabilityState();
    for (let i = 0; i < DISPLACED_VERSION_LIMIT; i++) {
      state.recordDisplacedVersion('doc', 'repeat');
    }
    state.recordDisplacedVersion('doc', 'distinct');

    expect(state.isDisplacedVersion('doc', 'repeat')).toBe(true);
    expect(state.isDisplacedVersion('doc', 'distinct')).toBe(true);
  });

  test('a displaced version expires on read once its TTL has passed', () => {
    vi.useFakeTimers();
    try {
      const state = new DocumentDurabilityState();
      state.recordDisplacedVersion('doc', 'v1 bytes');
      expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(true);

      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1_000);

      expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('displaced versions are scoped to the branch that displaced them', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'main v1');
    state.switchReconciledBaseScope('feature');

    expect(state.isDisplacedVersion('doc', 'main v1')).toBe(false);
    state.recordDisplacedVersion('doc', 'feature v1');
    state.switchReconciledBaseScope('main');
    expect(state.isDisplacedVersion('doc', 'feature v1')).toBe(false);
    expect(state.isDisplacedVersion('doc', 'main v1')).toBe(true);
  });

  test('deleting a doc clears its displaced versions, leaving other documents intact', () => {
    const state = new DocumentDurabilityState();
    state.recordDisplacedVersion('doc', 'v1 bytes');
    state.recordDisplacedVersion('other', 'v1 bytes');

    state.deleteReconciledBase('doc');

    expect(state.isDisplacedVersion('doc', 'v1 bytes')).toBe(false);
    expect(state.isDisplacedVersion('other', 'v1 bytes')).toBe(true);
  });

  test('tracks stale external conflicts per branch and clears them with document state', () => {
    const state = new DocumentDurabilityState();
    const conflict = state.recordStaleExternalWrite('doc', 'stale bytes');

    expect(state.staleExternalWriteMatches('doc', 'stale bytes')).toBe(true);
    expect(state.listStaleExternalWrites()).toEqual([conflict]);
    state.switchReconciledBaseScope('feature');
    expect(state.listStaleExternalWrites()).toEqual([]);
    state.switchReconciledBaseScope('main');
    state.deleteReconciledBase('doc');
    expect(state.listStaleExternalWrites()).toEqual([]);
  });

  test('restores displaced history, acknowledged content, and unresolved conflicts after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-state-'));
    const persistencePath = join(dir, 'stale-external-writes.json');
    try {
      const first = new DocumentDurabilityState('main', { persistencePath });
      first.setReconciledBase('doc', 'old bytes');
      first.recordDisplacedVersion('doc', 'old bytes');
      first.setReconciledBase('doc', 'acknowledged bytes');
      first.recordStaleExternalWrite('doc', 'old bytes');

      const restored = new DocumentDurabilityState('main', { persistencePath });

      expect(restored.getReconciledBase('doc')).toBe('acknowledged bytes');
      expect(restored.isDisplacedVersion('doc', 'old bytes')).toBe(true);
      expect(restored.staleExternalWriteMatches('doc', 'old bytes')).toBe(true);

      restored.deleteReconciledBase('doc');
      const afterDelete = new DocumentDurabilityState('main', { persistencePath });
      expect(afterDelete.getReconciledBase('doc')).toBeUndefined();
      expect(afterDelete.isDisplacedVersion('doc', 'old bytes')).toBe(false);
      expect(afterDelete.staleExternalWriteMatches('doc', 'old bytes')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps unresolved persisted conflicts after their displaced-history window expires', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-conflict-'));
    const persistencePath = join(dir, 'stale-external-writes.json');
    try {
      const first = new DocumentDurabilityState('main', { persistencePath });
      first.setReconciledBase('doc', 'acknowledged bytes');
      first.recordDisplacedVersion('doc', 'old bytes');
      first.recordStaleExternalWrite('doc', 'old bytes');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1_000);

      const restored = new DocumentDurabilityState('main', { persistencePath });

      expect(restored.getReconciledBase('doc')).toBe('acknowledged bytes');
      expect(restored.isDisplacedVersion('doc', 'old bytes')).toBe(false);
      expect(restored.staleExternalWriteMatches('doc', 'old bytes')).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sweeps expired inactive history without expiring unresolved conflicts', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-expiry-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('expired-doc', 'acknowledged');
      state.recordDisplacedVersion('expired-doc', 'old');
      state.setReconciledBase('conflicted-doc', 'preserved');
      state.recordDisplacedVersion('conflicted-doc', 'rejected');
      state.recordStaleExternalWrite('conflicted-doc', 'rejected');
      state.switchReconciledBaseScope('feature');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);
      state.setReconciledBase('fresh-doc', 'new acknowledged');
      state.recordDisplacedVersion('fresh-doc', 'new old');
      const serialized = readFileSync(persistencePath, 'utf-8');
      expect(serialized).not.toContain('expired-doc');
      expect(serialized).toContain('conflicted-doc');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getReconciledBase('conflicted-doc')).toBe('preserved');
      expect(restored.staleExternalWriteMatches('conflicted-doc', 'rejected')).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a branch switch purges expired restored plaintext but retains unresolved recovery data', () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-restored-expiry-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('expired', 'expired plaintext');
      state.recordDisplacedVersion('expired', 'old');
      state.setReconciledBase('pending', 'protected plaintext');
      state.recordStaleExternalWrite('pending', 'rejected');
      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1);
      const beforeRestore = readFileSync(persistencePath, 'utf-8');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getReconciledBase('expired')).toBeUndefined();
      expect(readFileSync(persistencePath, 'utf-8')).toBe(beforeRestore);
      restored.switchReconciledBaseScope('feature');
      expect(readFileSync(persistencePath, 'utf-8')).not.toContain('expired plaintext');
      expect(readFileSync(persistencePath, 'utf-8')).toContain('protected plaintext');
      expect(readFileSync(persistencePath, 'utf-8')).toContain('rejected');
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed durable clearing retains the conflict until a successful retry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-clear-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordStaleExternalWrite('doc', 'rejected');
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      expect(() => state.clearStaleExternalWrite('doc')).toThrow();
      expect(state.getStaleExternalWrite('doc')?.diskContent).toBe('rejected');
      expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
      rmSync(persistencePath, { recursive: true });
      renameSync(`${persistencePath}.backup`, persistencePath);
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('doc')?.diskContent).toBe('rejected');
      state.clearStaleExternalWrite('doc');
      expect(state.getStaleExternalWrite('doc')).toBeUndefined();
      expect(
        new DocumentDurabilityState('main', { persistencePath }).getStaleExternalWrite('doc'),
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['{invalid', 'corrupt'],
    [JSON.stringify({ version: 2, branches: {} }), 'incompatible'],
    [JSON.stringify({ version: 1, branches: { main: [{ docName: 'bad' }] } }), 'corrupt'],
  ])('preserves invalid recovery state and fails with actionable %s diagnostics', (raw, kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-invalid-'));
    const persistencePath = join(dir, 'state.json');
    try {
      writeFileSync(persistencePath, raw);
      expect(() => new DocumentDurabilityState('main', { persistencePath })).toThrow(
        DocumentDurabilityStateError,
      );
      try {
        new DocumentDurabilityState('main', { persistencePath });
      } catch (error) {
        expect(error).toMatchObject({ kind, path: persistencePath });
        expect(error instanceof Error ? error.message : '').toContain('Do not delete');
      }
      expect(readFileSync(persistencePath, 'utf-8')).toBe(raw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports an unreadable snapshot without replacing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-unreadable-'));
    const persistencePath = join(dir, 'state.json');
    try {
      mkdirSync(persistencePath);
      expect(() => new DocumentDurabilityState('main', { persistencePath })).toThrow(
        expect.objectContaining({ kind: 'unreadable', path: persistencePath }),
      );
      expect(statSync(persistencePath).isDirectory()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ['EACCES', 'permissions'],
    ['EPERM', 'permissions'],
    ['EISDIR', 'regular file'],
    ['EIO', 'filesystem'],
  ])('unreadable %s diagnostics name the filesystem problem', (code, guidance) => {
    const cause = Object.assign(new Error('read failed'), { code });
    const error = new DocumentDurabilityStateError('/project/state.json', 'unreadable', cause);
    expect(error.message).toContain(code);
    expect(error.message).toContain(guidance);
    expect(error.message).not.toContain('Restore this snapshot from a known-good backup');
    expect(error.cause).toBe(cause);
  });

  test('incompatible diagnostics do not claim an unrecorded writer version is known', () => {
    const error = new DocumentDurabilityStateError('/project/state.json', 'incompatible');
    expect(error.message).not.toContain('version that wrote');
    expect(error.message).toContain('schema');
  });

  test('a tracked target is re-derived from docName rather than trusted from the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-target-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('protected', 'acknowledged');
      state.recordStaleExternalWrite('protected', 'old');
      const tampered = readFileSync(persistencePath, 'utf-8').replace(
        '"file":"protected.md"',
        '"file":"unrelated.md"',
      );
      writeFileSync(persistencePath, tampered);
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('protected')?.file).toBe('protected.md');
      expect(restored.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'protected.md',
      ]);
      expect(readFileSync(persistencePath, 'utf-8')).toBe(tampered);
      const invalidPath = new Error('document path escapes content directory');
      expect(
        () =>
          new DocumentDurabilityState('main', {
            persistencePath,
            fileForDocName: () => {
              throw invalidPath;
            },
          }),
      ).toThrow(expect.objectContaining({ kind: 'corrupt', cause: invalidPath }));
      expect(readFileSync(persistencePath, 'utf-8')).toBe(tampered);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('re-recording the same disk hash with a new retained edit does not count a new conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-recount-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      const beforeCount = getMetrics().staleExternalWriteRefused;
      state.recordStaleExternalWrite('doc', 'old');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      const first = state.getStaleExternalWrite('doc');
      state.recordStaleExternalWrite('doc', 'old', 'a pending edit');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      expect(state.getStaleExternalWrite('doc')?.retainedContent).toBe('a pending edit');
      expect(state.getStaleExternalWrite('doc')?.detectedAt).toBe(first?.detectedAt);
      state.recordStaleExternalWrite('doc', 'newer disk bytes');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an .mdx document restored before the watcher scan resolves to its .mdx file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mdx-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      registerDocExtension('notes/guide', '.mdx');
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('notes/guide', 'acknowledged');
      state.recordStaleExternalWrite('notes/guide', 'old');
      expect(state.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(booting.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');
      expect(booting.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'notes/guide.mdx',
      ]);
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a scan that observes .md displaces an .mdx snapshot instead of being outranked by it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mdx-renamed-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      registerDocExtension('notes/guide', '.mdx');
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('notes/guide', 'acknowledged');
      state.recordStaleExternalWrite('notes/guide', 'old');
      expect(state.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.mdx');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(registerDocExtension('notes/guide', '.md')).toEqual({
        effective: '.md',
        changed: true,
        shadowed: null,
      });
      expect(booting.getStaleExternalWrite('notes/guide')?.file).toBe('notes/guide.md');
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a restored file naming an extension the registry rejects still opens the project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-mmd-'));
    const persistencePath = join(dir, 'state.json');
    const options = {
      persistencePath,
      fileForDocName: docNameToRelativePath,
      hasResolvedExtension: isRegisteredMarkdownDocName,
    };
    try {
      _resetDocExtensionsForTests();
      const state = new DocumentDurabilityState('main', options);
      state.setReconciledBase('flow.mmd', 'acknowledged');
      state.recordStaleExternalWrite('flow.mmd', 'old');
      expect(state.getStaleExternalWrite('flow.mmd')?.file).toBe('flow.mmd');

      _resetDocExtensionsForTests();
      const booting = new DocumentDurabilityState('main', options);
      expect(booting.getStaleExternalWrite('flow.mmd')?.file).toBe('flow.mmd');
    } finally {
      _resetDocExtensionsForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a conflict file is re-derived from the resolver on every read, never replayed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-moved-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `sub/${docName}.md`,
      });
      state.setReconciledBase('guide', 'acknowledged');
      state.recordStaleExternalWrite('guide', 'old');
      expect(state.getStaleExternalWrite('guide')?.file).toBe('sub/guide.md');

      const moved = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `moved/${docName}.md`,
      });
      expect(moved.getStaleExternalWrite('guide')?.file).toBe('moved/guide.md');
      expect(moved.listStaleExternalWrites().map((entry) => entry.file)).toEqual([
        'moved/guide.md',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unrelated mutation on a document whose conflict file moved does not re-notify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-renotify-'));
    const persistencePath = join(dir, 'state.json');
    const changed = vi.fn();
    let prefix = 'sub';
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        fileForDocName: (docName) => `${prefix}/${docName}.md`,
        onStaleExternalWriteChange: changed,
      });
      state.setReconciledBase('guide', 'acknowledged');
      state.recordStaleExternalWrite('guide', 'old');
      expect(changed).toHaveBeenCalledTimes(1);

      prefix = 'moved';
      expect(state.getStaleExternalWrite('guide')?.file).toBe('moved/guide.md');
      state.setReconciledBase('guide', 'a later acknowledgement');
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ordinary clears and branch switches create no snapshot, and restore does not rewrite one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-noop-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('ordinary', 'content');
      state.clearStaleExternalWrite('ordinary');
      state.clearDisplacedVersions('ordinary');
      state.deleteReconciledBase('ordinary');
      state.switchReconciledBaseScope('feature');
      expect(existsSync(persistencePath)).toBe(false);
      state.setReconciledBase('protected', 'content');
      state.recordDisplacedVersion('protected', 'old');
      utimesSync(persistencePath, 1, 1);
      const before = statSync(persistencePath);
      new DocumentDurabilityState('feature', { persistencePath });
      expect(statSync(persistencePath).mtimeMs).toBe(before.mtimeMs);
      if (process.platform !== 'win32') expect(before.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('all persisted mutators retain their previous state when the atomic replacement fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-atomic-'));
    const persistencePath = join(dir, 'state.json');
    const changed = vi.fn();
    try {
      const state = new DocumentDurabilityState('main', {
        persistencePath,
        onStaleExternalWriteChange: changed,
      });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordDisplacedVersion('doc', 'old');
      const beforeCount = getMetrics().staleExternalWriteRefused;
      state.recordStaleExternalWrite('doc', 'old');
      state.recordStaleExternalWrite('doc', 'old');
      expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
      expect(changed).toHaveBeenCalledTimes(1);
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      for (const mutate of [
        () => state.setReconciledBase('doc', 'changed'),
        () => state.recordDisplacedVersion('doc', 'another'),
        () => state.clearDisplacedVersions('doc'),
        () => state.recordStaleExternalWrite('doc', 'another'),
        () => state.clearStaleExternalWrite('doc'),
        () => state.deleteReconciledBase('doc'),
      ]) {
        expect(mutate).toThrow();
        expect(state.getReconciledBase('doc')).toBe('acknowledged');
        expect(state.getStaleExternalWrite('doc')?.diskContent).toBe('old');
        expect(state.isDisplacedVersion('doc', 'old')).toBe(true);
        expect(state.isDisplacedVersion('doc', 'another')).toBe(false);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(getMetrics().staleExternalWriteRefused).toBe(beforeCount + 1);
        expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
      }
      rmSync(persistencePath, { recursive: true });
      renameSync(`${persistencePath}.backup`, persistencePath);
      const restored = new DocumentDurabilityState('main', {
        persistencePath,
        onStaleExternalWriteChange: changed,
      });
      expect(changed).toHaveBeenCalledTimes(1);
      restored.clearStaleExternalWrite('doc');
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps the original replacement failure when temporary-file cleanup also fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-cleanup-'));
    const persistencePath = join(dir, 'state.json');
    let originalError: unknown;
    const state = new DocumentDurabilityState('main', { persistencePath });
    state.setReconciledBase('doc', 'acknowledged');
    mkdirSync(persistencePath);
    const renameSpy = vi.spyOn(tracedFs, 'tracedRenameSync').mockImplementation((from, to) => {
      try {
        renameSync(from, to);
      } catch (cause) {
        originalError = cause;
        rmSync(from);
        mkdirSync(from);
        throw cause;
      }
    });
    const warnSpy = vi.spyOn(getLogger('document-durability-state'), 'warn');
    try {
      let actualError: unknown;
      try {
        state.recordDisplacedVersion('doc', 'old');
      } catch (cause) {
        actualError = cause;
      }
      expect(originalError).toBeInstanceOf(Error);
      expect(actualError).toBe(originalError);
      expect(state.isDisplacedVersion('doc', 'old')).toBe(false);
      const payload = (warnSpy.mock.calls[0]?.[0] ?? {}) as { writeError?: unknown };
      expect(payload.writeError).toBe((originalError as Error).message);
      expect(JSON.stringify(payload.writeError)).not.toBe('{}');
    } finally {
      warnSpy.mockRestore();
      renameSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a different rejected version preserves the retained candidate across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-durability-retained-'));
    const persistencePath = join(dir, 'state.json');
    try {
      const state = new DocumentDurabilityState('main', { persistencePath });
      state.setReconciledBase('doc', 'acknowledged');
      state.recordDisplacedVersion('doc', 'old A');
      state.recordDisplacedVersion('doc', 'old Z');
      state.recordStaleExternalWrite('doc', 'old A', 'retained C');
      state.recordStaleExternalWrite('doc', 'old Z');
      const restored = new DocumentDurabilityState('main', { persistencePath });
      expect(restored.getStaleExternalWrite('doc')).toMatchObject({
        diskContent: 'old Z',
        retainedContent: 'retained C',
      });
      restored.recordStaleExternalWrite('doc', 'old A', '');
      expect(restored.getStaleExternalWrite('doc')?.retainedContent).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
