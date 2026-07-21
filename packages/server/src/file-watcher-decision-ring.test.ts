/**
 * Watcher decision-ring coverage: the bounded record of recent file-watcher
 * decisions (dispatched / self-write skips / drops) that backs the
 * `/api/metrics/watcher-recent` endpoint and the `state/watcher-recent.jsonl`
 * bundle artifact. Drives the ring through the real pipeline entry points
 * (`handleRawEvents` / `classifyEvents`) so the recorded decisions reflect
 * production drop sites, not a synthetic recorder.
 */

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContentFilter } from './content-filter.ts';
import type { DiskEvent, FileIndexEntry, FolderIndexEntry } from './file-watcher';
import {
  classifyEvents,
  getWatcherDecisionRingSnapshot,
  handleRawEvents,
  lastKnownHash,
  logWatcherDropSummary,
  resetWatcherDecisionDiagnostics,
  writeTracker,
} from './file-watcher';
import { getLogger } from './logger.ts';

let tmpDir: string;
let contentDir: string;

beforeEach(async () => {
  tmpDir = realpathSync(await mkdtemp(resolve(tmpdir(), 'ok-watcher-ring-')));
  contentDir = resolve(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  resetWatcherDecisionDiagnostics();
  writeTracker.clear();
  lastKnownHash.clear();
});

afterEach(async () => {
  resetWatcherDecisionDiagnostics();
  writeTracker.clear();
  lastKnownHash.clear();
  await rm(tmpDir, { recursive: true, force: true });
});

async function runBatch(
  rawEvents: Array<{ type: 'create' | 'update' | 'delete'; path: string }>,
  contentFilter?: ReturnType<typeof createContentFilter>,
): Promise<DiskEvent[]> {
  const dispatched: DiskEvent[] = [];
  await handleRawEvents(
    rawEvents,
    contentDir,
    contentFilter,
    new Map<string, FileIndexEntry>(),
    new Map<string, FolderIndexEntry>(),
    async (event) => {
      dispatched.push(event);
    },
  );
  return dispatched;
}

describe('watcher decision ring', () => {
  test('dispatched markdown events are recorded with normalized paths', async () => {
    const filePath = resolve(contentDir, 'notes', 'guide.md');
    mkdirSync(resolve(contentDir, 'notes'), { recursive: true });
    writeFileSync(filePath, '# Guide\n');

    const dispatched = await runBatch([{ type: 'create', path: filePath }]);
    expect(dispatched.some((e) => e.kind === 'create')).toBe(true);

    const records = getWatcherDecisionRingSnapshot();
    const record = records.find((r) => r.decision === 'dispatched' && r.kind === 'create');
    expect(record).toBeDefined();
    // Path is normalized to the last two segments — never the raw absolute path.
    expect(record?.path).toBe(`...${sep}notes${sep}guide.md`);
    expect(record?.path.includes(tmpDir)).toBe(false);
    expect(record?.pathRole).toBe('content-md');
    expect(record?.ts).toBeGreaterThan(0);
  });

  test('a symlink escaping contentDir records drop-symlink-escape and never dispatches', async () => {
    const outsideTarget = resolve(tmpDir, 'outside.md');
    writeFileSync(outsideTarget, '# Outside\n');
    const linkPath = resolve(contentDir, 'escape.md');
    symlinkSync(outsideTarget, linkPath);

    const dispatched = await runBatch([{ type: 'create', path: linkPath }]);
    expect(dispatched).toHaveLength(0);

    const records = getWatcherDecisionRingSnapshot();
    expect(records.some((r) => r.decision === 'drop-symlink-escape' && r.kind === 'create')).toBe(
      true,
    );
    expect(records.some((r) => r.decision === 'dispatched')).toBe(false);
  });

  test('ContentFilter exclusion records drop-filter-excluded', async () => {
    writeFileSync(resolve(tmpDir, '.gitignore'), 'dist/\n');
    const filter = createContentFilter({ projectDir: tmpDir, contentDir });
    mkdirSync(resolve(contentDir, 'dist'), { recursive: true });
    const excludedPath = resolve(contentDir, 'dist', 'output.md');
    writeFileSync(excludedPath, '# Build Output\n');

    const events = await classifyEvents(
      [{ type: 'create', path: excludedPath }],
      contentDir,
      filter,
    );
    expect(events).toHaveLength(0);

    const records = getWatcherDecisionRingSnapshot();
    const record = records.find((r) => r.decision === 'drop-filter-excluded');
    expect(record).toBeDefined();
    expect(record?.kind).toBe('create');
    expect(record?.path).toBe(`...${sep}dist${sep}output.md`);
  });

  test('an unreadable create (delete race) records drop-read-failed', async () => {
    const vanished = resolve(contentDir, 'vanished.md');

    const events = await classifyEvents([{ type: 'create', path: vanished }], contentDir);
    expect(events).toHaveLength(0);

    const records = getWatcherDecisionRingSnapshot();
    expect(records.some((r) => r.decision === 'drop-read-failed' && r.kind === 'create')).toBe(
      true,
    );
  });

  test('self-writes record self-write-skip instead of dispatched', async () => {
    const filePath = resolve(contentDir, 'self.md');
    const content = '# Self write\n';
    writeFileSync(filePath, content);
    const { registerWrite, contentHash } = await import('./file-watcher');
    registerWrite(filePath, contentHash(content));

    const dispatched = await runBatch([{ type: 'create', path: filePath }]);
    expect(dispatched.some((e) => e.kind === 'create')).toBe(false);

    const records = getWatcherDecisionRingSnapshot();
    expect(records.some((r) => r.decision === 'self-write-skip' && r.kind === 'create')).toBe(true);
  });

  test('ring is bounded: oldest decisions are evicted past capacity', async () => {
    // 300 unreadable creates → 300 drop-read-failed decisions; the ring
    // retains only the newest 256.
    for (let i = 0; i < 300; i++) {
      await classifyEvents(
        [{ type: 'create', path: resolve(contentDir, `missing-${i}.md`) }],
        contentDir,
      );
    }
    const records = getWatcherDecisionRingSnapshot();
    expect(records).toHaveLength(256);
    expect(records[0]?.path).toBe(`...${sep}content${sep}missing-44.md`);
    expect(records.at(-1)?.path).toBe(`...${sep}content${sep}missing-299.md`);
  });

  test('snapshot returns copies — mutating a returned record does not corrupt the ring', async () => {
    await classifyEvents([{ type: 'create', path: resolve(contentDir, 'gone.md') }], contentDir);
    const first = getWatcherDecisionRingSnapshot();
    const record = first[0];
    expect(record).toBeDefined();
    if (!record) return;
    record.path = 'mutated';
    expect(getWatcherDecisionRingSnapshot()[0]?.path).not.toBe('mutated');
  });

  test('resetWatcherDecisionDiagnostics clears the ring', async () => {
    await classifyEvents([{ type: 'create', path: resolve(contentDir, 'gone.md') }], contentDir);
    expect(getWatcherDecisionRingSnapshot().length).toBeGreaterThan(0);
    resetWatcherDecisionDiagnostics();
    expect(getWatcherDecisionRingSnapshot()).toHaveLength(0);
  });
});

describe('watcher drop summary', () => {
  test('emits only when drops accrued, with per-reason totals, then resets the window', async () => {
    // The module-level `log` in file-watcher.ts is the factory-cached
    // 'file-watcher' logger — spying on the cached instance intercepts the
    // summary emission.
    const infoSpy = vi.spyOn(getLogger('file-watcher'), 'info');
    try {
      logWatcherDropSummary();
      expect(infoSpy).not.toHaveBeenCalled();

      await classifyEvents(
        [{ type: 'create', path: resolve(contentDir, 'missing.md') }],
        contentDir,
      );
      logWatcherDropSummary();
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const [payload] = infoSpy.mock.calls[0] ?? [];
      expect(payload).toMatchObject({
        droppedSinceLastSummary: 1,
        dropTotals: { 'read-failed': 1 },
      });

      // Window reset: no new drops since the last summary → silent again.
      logWatcherDropSummary();
      expect(infoSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
