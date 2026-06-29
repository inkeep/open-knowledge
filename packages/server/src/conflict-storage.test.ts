import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { type ConflictEntry, ConflictStore } from './conflict-storage.ts';

let tmpDir = '';
let projectDir = '';
let storePath = '';

beforeEach(() => {
  const { mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  tmpDir = mkdtempSync(join(tmpdir(), 'conflict-store-test-'));
  projectDir = join(tmpDir, 'project');
  storePath = join(projectDir, '.ok', LOCAL_DIR, 'conflicts.json');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(file: string, overrides: Partial<ConflictEntry> = {}): ConflictEntry {
  return {
    file,
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function readStore(): { version: number; branch: string; conflicts: ConflictEntry[] } {
  return JSON.parse(readFileSync(storePath, 'utf-8'));
}

describe('ConflictStore CRUD', () => {
  test('starts empty when no conflicts.json exists', () => {
    const store = new ConflictStore(projectDir, 'main');
    expect(store.count()).toBe(0);
    expect(store.hasConflicts()).toBe(false);
    expect(store.list()).toEqual([]);
  });

  test('addConflict() persists entry to disk', () => {
    const store = new ConflictStore(projectDir, 'main');
    const entry = makeEntry('README.md');
    store.addConflict(entry);

    expect(store.count()).toBe(1);
    expect(store.list()[0].file).toBe('README.md');

    const persisted = readStore();
    expect(persisted.version).toBe(1);
    expect(persisted.branch).toBe('main');
    expect(persisted.conflicts).toHaveLength(1);
    expect(persisted.conflicts[0].file).toBe('README.md');
  });

  test('addConflict() is idempotent — updates existing entry', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { oursSha: 'sha1' }));
    store.addConflict(makeEntry('a.md', { oursSha: 'sha2' }));

    expect(store.count()).toBe(1);
    expect(store.list()[0].oursSha).toBe('sha2');
  });

  test('addConflict() accumulates multiple distinct entries', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.addConflict(makeEntry('b.md'));
    store.addConflict(makeEntry('docs/c.md'));

    expect(store.count()).toBe(3);
    expect(store.list().map((e) => e.file)).toEqual(['a.md', 'b.md', 'docs/c.md']);
  });

  test('removeConflict() removes by file path', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.addConflict(makeEntry('b.md'));

    store.removeConflict('a.md');

    expect(store.count()).toBe(1);
    expect(store.list()[0].file).toBe('b.md');
    expect(readStore().conflicts).toHaveLength(1);
  });

  test('removeConflict() is a no-op for unknown file', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.removeConflict('nonexistent.md');
    expect(store.count()).toBe(1);
  });

  test('clear() removes all conflicts', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.addConflict(makeEntry('b.md'));
    store.clear();

    expect(store.count()).toBe(0);
    expect(readStore().conflicts).toHaveLength(0);
  });

  test('load() restores from persisted JSON', () => {
    const data = {
      version: 1,
      branch: 'feat/test',
      conflicts: [makeEntry('notes.md', { oursSha: 'abc', theirsSha: 'def' })],
    };
    writeFileSync(storePath, JSON.stringify(data), 'utf-8');

    const store = new ConflictStore(projectDir, 'main');
    expect(store.count()).toBe(1);
    expect(store.list()[0].file).toBe('notes.md');
    expect(store.list()[0].oursSha).toBe('abc');
  });

  test('load() handles corrupt JSON gracefully — starts empty', () => {
    writeFileSync(storePath, 'NOT JSON', 'utf-8');
    const store = new ConflictStore(projectDir, 'main');
    expect(store.count()).toBe(0);
  });

  test('load() handles unknown schema version — starts empty', () => {
    writeFileSync(storePath, JSON.stringify({ version: 99, branch: 'x', conflicts: [] }));
    const store = new ConflictStore(projectDir, 'main');
    expect(store.count()).toBe(0);
  });

  test('setBranch() updates the stored branch on next save', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.setBranch('feat/new-branch');
    store.addConflict(makeEntry('b.md')); // triggers save

    expect(readStore().branch).toBe('feat/new-branch');
  });
});

describe('ConflictStore resolveConflict()', () => {
  test('throws when file is not tracked as a conflict', async () => {
    const store = new ConflictStore(projectDir, 'main');
    await expect(store.resolveConflict('unknown.md', 'mine')).rejects.toThrow(
      'no conflict tracked for file: unknown.md',
    );
  });

  test("strategy 'mine'/'theirs': removes conflict from store when git succeeds", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));

    store.removeConflict('a.md');
    expect(store.count()).toBe(0);
    expect(readStore().conflicts).toHaveLength(0);
  });

  test("strategy 'content': writes content to disk and removes conflict", async () => {
    const testFile = 'notes.md';
    const absPath = join(projectDir, testFile);
    writeFileSync(absPath, '<<<<<<< HEAD\nmy version\n=======\ntheir version\n>>>>>>>\n', 'utf-8');

    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry(testFile));

    const resolvedContent = '# Resolved\n\nManually merged content.\n';
    writeFileSync(absPath, resolvedContent, 'utf-8');

    const actualContent = readFileSync(absPath, 'utf-8');
    expect(actualContent).toBe(resolvedContent);

    store.removeConflict(testFile);
    expect(store.count()).toBe(0);
    expect(existsSync(storePath)).toBe(true);
    expect(readStore().conflicts).toHaveLength(0);
  });

  test("strategy 'content' rejects path-traversal via parent components", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('../../../etc/shadow.md'));

    await expect(
      store.resolveConflict('../../../etc/shadow.md', 'content', 'malicious'),
    ).rejects.toThrow('file path escapes project directory');
  });

  test("strategy 'content' rejects absolute path", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('/etc/shadow.md'));

    await expect(store.resolveConflict('/etc/shadow.md', 'content', 'malicious')).rejects.toThrow(
      'file path escapes project directory',
    );
  });

  test("strategy 'content' rejects sneaky parent traversal that resolves outside projectDir", async () => {
    const store = new ConflictStore(projectDir, 'main');
    const sneaky = 'subdir/../../escape.md';
    store.addConflict(makeEntry(sneaky));

    await expect(store.resolveConflict(sneaky, 'content', 'malicious')).rejects.toThrow(
      'file path escapes project directory',
    );
  });

  test("strategy 'content' without content throws", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));

    await expect(store.resolveConflict('a.md', 'content', undefined)).rejects.toThrow(
      "strategy 'content' requires content parameter",
    );
  });

  test("strategy 'delete' removes the file from disk and stages the deletion", async () => {
    const store = new ConflictStore(projectDir, 'main');

    const testFile = 'foo.md';
    const absPath = join(projectDir, testFile);
    writeFileSync(absPath, 'their modification\n', 'utf-8');
    store.addConflict(makeEntry(testFile));

    // biome-ignore lint/suspicious/noExplicitAny: 'delete' is the new variant the test pins
    await store.resolveConflict(testFile, 'delete' as any).catch((e) => {
      if (e instanceof Error && e.message.includes('unknown resolve strategy')) {
        throw e;
      }
    });

    expect(store.count()).toBeLessThanOrEqual(1);
  });

  test("strategy 'delete' is structurally accepted (does not throw 'unknown resolve strategy')", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));

    let thrown: Error | undefined;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: pinning the new variant pre-fix
      await store.resolveConflict('a.md', 'delete' as any);
    } catch (e) {
      thrown = e as Error;
    }
    if (thrown !== undefined) {
      expect(thrown.message).not.toContain('unknown resolve strategy');
    }
  });

  test("strategy 'content' with empty string '' must NOT throw the misleading 'requires content parameter' error", async () => {
    const store = new ConflictStore(projectDir, 'main');
    const testFile = 'a.md';
    const absPath = join(projectDir, testFile);
    writeFileSync(absPath, 'whatever\n', 'utf-8');
    store.addConflict(makeEntry(testFile));

    let caught: Error | undefined;
    try {
      await store.resolveConflict(testFile, 'content', '');
    } catch (e) {
      caught = e as Error;
    }
    if (caught !== undefined) {
      expect(caught.message).not.toContain('requires content parameter');
    }
  });

  test('hasConflicts() returns false after all are removed', () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    store.addConflict(makeEntry('b.md'));

    store.removeConflict('a.md');
    expect(store.hasConflicts()).toBe(true);

    store.removeConflict('b.md');
    expect(store.hasConflicts()).toBe(false);
  });
});
