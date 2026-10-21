import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type DiskEvent, lastKnownHash, startWatcher, type WatcherHandle } from './file-watcher.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock, type ManualClock } from './watcher-clock.test-helper.ts';

const fakeChokidar = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeWatcher {
    closed = false;
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
        );
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  const watchers: FakeWatcher[] = [];
  return {
    watchers,
    watch: () => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      queueMicrotask(() => watcher.emit('ready'));
      return watcher;
    },
  };
});

vi.mock('chokidar', () => ({ watch: fakeChokidar.watch }));

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function errorWithCode(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('chokidar watcher resubscribe', () => {
  let tmpDir: string;
  let contentDir: string;
  let handle: WatcherHandle | undefined;
  let clock: ManualClock;
  let events: DiskEvent[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-chokidar-resubscribe-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    contentDir = realpathSync(contentDir);
    lastKnownHash.clear();
    fakeChokidar.watchers.length = 0;
    clock = createManualClock(Date.now());
    events = [];
    handle = await startWatcher(
      contentDir,
      async (event) => {
        events.push(event);
      },
      undefined,
      { forceBackend: 'chokidar', clock, freshnessIntervalMs: null, platform: 'linux' },
    );
  });

  afterEach(async () => {
    await handle?.unsubscribe();
    handle = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('an error that stops chokidar makes the watcher watch again and re-check the tree', async () => {
    expect(fakeChokidar.watchers).toHaveLength(1);
    const first = fakeChokidar.watchers[0];
    writeFileSync(join(contentDir, 'gap.md'), '# Written while chokidar was failing\n');

    first?.emit('error', new Error('the watcher stopped'));
    clock.advance(0);

    await until(() => fakeChokidar.watchers.length === 2, 'a second chokidar watcher');
    expect(first?.closed).toBe(true);
    await until(
      () => events.some((event) => event.kind === 'create' && event.docName === 'gap'),
      'the re-check to find the gap write',
    );
  });

  test.each([
    ['EACCES', 'permission denied'],
    ['ENOSPC', 'inotify watch limit reached'],
    ['EMFILE', 'too many open files'],
    ['ENFILE', 'file table overflow'],
  ])('a %s error is counted while the watcher stays up', async (code, message) => {
    const errorsBefore = getMetrics().watcherErrors;
    const resubscribesBefore = getMetrics().watcherResubscribes;
    fakeChokidar.watchers[0]?.emit('error', errorWithCode(message, code));
    fakeChokidar.watchers[0]?.emit('error', errorWithCode(message, code));
    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getMetrics().watcherErrors - errorsBefore).toBe(2);
    expect(getMetrics().watcherResubscribes - resubscribesBefore).toBe(0);
    expect(fakeChokidar.watchers).toHaveLength(1);
    expect(fakeChokidar.watchers[0]?.closed).toBe(false);
  });
});
