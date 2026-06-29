import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBasenameIndex } from '@inkeep/open-knowledge-core';
import { seedBasenameIndex } from './asset-walk.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { startWatcher } from './file-watcher.ts';
import { TagIndex } from './tag-index.ts';

const DIR_COUNT = 100;
const FILES_PER_DIR = 2;

let baseDir: string;
let contentDir: string;
let expectedDocs: Set<string>;
let expectedAssets: Set<string>;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'ok-boot-walk-'));
  contentDir = join(baseDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  expectedDocs = new Set();
  expectedAssets = new Set();
  for (let d = 0; d < DIR_COUNT; d++) {
    const dir = join(contentDir, `dir-${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f++) {
      writeFileSync(join(dir, `note-${f}.md`), `# note ${d}/${f}\n#tag-${d}\n`, 'utf-8');
      expectedDocs.add(`dir-${d}/note-${f}`);
    }
    writeFileSync(join(dir, `pic-${d}.png`), 'bytes', 'utf-8');
    expectedAssets.add(`dir-${d}/pic-${d}.png`);
  }
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

async function timerFiresDuring<T>(
  walk: () => Promise<T>,
): Promise<{ timerWon: boolean; result: T }> {
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 0);
  try {
    const result = await walk();
    return { timerWon: timerFired, result };
  } finally {
    clearTimeout(timer);
  }
}

describe('boot-time walks yield to the event loop', () => {
  test('BacklinkIndex.rebuildFromDisk yields and collects every doc', async () => {
    const index = new BacklinkIndex({ projectDir: baseDir, contentDir });
    const { timerWon } = await timerFiresDuring(() => index.rebuildFromDisk());
    expect(timerWon).toBe(true);
    const nodeIds = new Set(index.getLinkGraph().nodes.map((n) => n.id.replace(/\\/g, '/')));
    expect(nodeIds).toEqual(expectedDocs);
  });

  test('TagIndex.init yields and indexes every doc', async () => {
    const index = new TagIndex({ contentDir });
    const { timerWon } = await timerFiresDuring(() => index.init());
    expect(timerWon).toBe(true);
    const indexed = new Set<string>();
    for (let d = 0; d < DIR_COUNT; d++) {
      for (const doc of index.getDocsForTag(`tag-${d}`)) {
        indexed.add(doc.replace(/\\/g, '/'));
      }
    }
    expect(indexed).toEqual(expectedDocs);
  });

  test('seedBasenameIndex yields and collects every asset', async () => {
    const idx = createBasenameIndex();
    const { timerWon } = await timerFiresDuring(() =>
      seedBasenameIndex({ contentDir, basenameIndex: idx }),
    );
    expect(timerWon).toBe(true);
    expect(idx.size()).toBe(expectedAssets.size);
    for (let d = 0; d < DIR_COUNT; d++) {
      expect(idx.resolveEmbed(`pic-${d}.png`, `dir-${d}/note-0.md`)).toBe(`dir-${d}/pic-${d}.png`);
    }
  });

  test('file-watcher seed walk yields and indexes every doc', async () => {
    const handle = await startWatcher(contentDir, async () => {});
    try {
      expect(new Set(handle.getFileIndex().keys())).toEqual(expectedDocs);
      const { timerWon } = await timerFiresDuring(() => handle.rescanFromDisk());
      expect(timerWon).toBe(true);
    } finally {
      await handle.unsubscribe();
    }
  });
});
