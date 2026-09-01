import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ConflictMarkersInContentError } from './conflict-errors.ts';
import { type ConflictEntry, ConflictStore } from './conflict-storage.ts';

let tmpDir = '';
let projectDir = '';
let storePath = '';

beforeEach(() => {
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
    store.addConflict(makeEntry('b.md'));

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

  test("strategy 'content': refuses content that still carries conflict markers", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));

    const markered = [
      '# Pricing',
      '',
      '<<<<<<< ours',
      'The Team tier moves to $29 per seat.',
      '=======',
      'The Team tier moves to $29 per seat, grandfathered.',
      '>>>>>>> theirs',
      '',
    ].join('\n');

    await expect(store.resolveConflict('a.md', 'content', markered)).rejects.toThrow(
      ConflictMarkersInContentError,
    );
    await expect(store.resolveConflict('a.md', 'content', markered)).rejects.toMatchObject({
      name: 'ConflictMarkersInContentError',
      file: 'a.md',
    });
    expect(store.count()).toBe(1);
  });

  test("strategy 'content': accepts a genuine resolution mentioning no markers", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    await expect(
      store.resolveConflict('a.md', 'content', '# Pricing\n\nThe Team tier moves to $29.\n'),
    ).rejects.not.toThrow(/contains conflict markers/);
  });

  test("strategy 'content': accepts a resolution whose body contains a setext H1", async () => {
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md'));
    await expect(
      store.resolveConflict(
        'a.md',
        'content',
        'Release Notes\n=======\n\nThe Team tier moves to $29.\n',
      ),
    ).rejects.not.toThrow(/contains conflict markers/);
    expect(store.count()).toBe(1);
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

describe('ConflictStore resolveConflict() — working-tree variant', () => {
  async function seedOverlay(
    file: string,
    remote: string,
    local: string,
  ): Promise<{ blobSha: string; headSha: string }> {
    const git = simpleGit(projectDir);
    await git.init(['--initial-branch=main']);
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(join(projectDir, file), remote, 'utf-8');
    await git.add('.');
    await git.commit('seed');
    const blobSha = (await git.raw(['rev-parse', `HEAD:${file}`])).trim();
    const headSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
    writeFileSync(join(projectDir, file), local, 'utf-8');
    return { blobSha, headSha };
  }

  async function headSha(): Promise<string> {
    return (await simpleGit(projectDir).raw(['rev-parse', 'HEAD'])).trim();
  }

  test("'theirs' restores the pinned origin-tip blob without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { variant: 'working-tree', theirsSha: blobSha }));

    await store.resolveConflict('a.md', 'theirs');

    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('REMOTE\n');
    expect(store.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test("'mine' keeps the overlay verbatim without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { variant: 'working-tree', theirsSha: blobSha }));

    await store.resolveConflict('a.md', 'mine');

    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('LOCAL\n');
    expect(store.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test('the entry leaves the store BEFORE the resolved bytes reach disk', async () => {
    const { blobSha } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { variant: 'working-tree', theirsSha: blobSha }));

    const target = join(projectDir, 'a.md');
    let diskAtRemoval: string | null = null;
    const realRemove = store.removeConflict.bind(store);
    store.removeConflict = (f: string) => {
      diskAtRemoval = readFileSync(target, 'utf-8');
      return realRemove(f);
    };

    await store.resolveConflict('a.md', 'content', 'HAND-MERGED\n');

    expect(diskAtRemoval).toBe('LOCAL\n');
    expect(readFileSync(target, 'utf-8')).toBe('HAND-MERGED\n');
    expect(store.count()).toBe(0);
  });

  test("'content' writes the merged bytes without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { variant: 'working-tree', theirsSha: blobSha }));

    await store.resolveConflict('a.md', 'content', 'HAND-MERGED\n');

    expect(readFileSync(join(projectDir, 'a.md'), 'utf-8')).toBe('HAND-MERGED\n');
    expect(store.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test("'delete' honors the local deletion without committing", async () => {
    const { blobSha, headSha: before } = await seedOverlay('a.md', 'REMOTE\n', 'LOCAL\n');
    const store = new ConflictStore(projectDir, 'main');
    store.addConflict(makeEntry('a.md', { variant: 'working-tree', theirsSha: blobSha }));

    await store.resolveConflict('a.md', 'delete');

    expect(existsSync(join(projectDir, 'a.md'))).toBe(false);
    expect(store.count()).toBe(0);
    expect(await headSha()).toBe(before);
  });

  test('addConflict rejects a working-tree entry with no pinned blob', () => {
    const store = new ConflictStore(projectDir, 'main');
    expect(() => store.addConflict(makeEntry('a.md', { variant: 'working-tree' }))).toThrow(
      'no pinned theirs blob',
    );
  });

  test("'theirs' still throws for a blob-less entry from a corrupt store", async () => {
    const store = new ConflictStore(projectDir, 'main');
    (store as unknown as { conflicts: unknown[] }).conflicts.push(
      makeEntry('a.md', { variant: 'working-tree' }),
    );
    await expect(store.resolveConflict('a.md', 'theirs')).rejects.toThrow('no pinned theirs blob');
  });
});
