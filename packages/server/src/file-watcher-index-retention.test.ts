import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { lastKnownHash, startWatcher, type WatcherHandle } from './file-watcher.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';

setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc') as () => void;

const DOCUMENT_COUNT = 300;
const BODY_BYTES = 64 * 1024;

let tmpDir: string;
let contentDir: string;
let handle: WatcherHandle | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-watcher-retention-'));
  contentDir = join(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  contentDir = realpathSync(contentDir);
  lastKnownHash.clear();
});

afterEach(async () => {
  await handle?.unsubscribe();
  handle = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

function settledHeapBytes(): number {
  collectGarbage();
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

test('the file index keeps titles and descriptions without keeping each document text alive', async () => {
  for (let index = 0; index < DOCUMENT_COUNT; index++) {
    const name = `doc-${String(index).padStart(4, '0')}`;
    writeFileSync(
      join(contentDir, `${name}.md`),
      `---\ntitle: Document title ${index}\ndescription: A description of document ${index}\n---\n\n# Heading of document ${index}\n\n${'x'.repeat(BODY_BYTES)}\n`,
    );
  }

  const before = settledHeapBytes();
  handle = await startWatcher(contentDir, async () => {}, undefined, {
    nativeBackend: createWatcherDouble().backend,
    clock: createManualClock(Date.now()),
    freshnessIntervalMs: null,
  });
  const retained = settledHeapBytes() - before;

  const entry = handle.getFileIndex().get('doc-0007');
  expect(entry?.title).toBe('Document title 7');
  expect(entry?.description).toBe('A description of document 7');
  expect(retained).toBeLessThan((DOCUMENT_COUNT * BODY_BYTES) / 4);
});
