import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createManagedRenameRecoveryJournal,
  managedRenameJournalPath,
  readManagedRenameJournal,
  recoverPendingManagedRename,
  withManagedRenameRecovery,
  writeManagedRenameJournal,
} from './managed-rename-journal.ts';

let tmpDir = '';

function setupTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-managed-rename-journal-'));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

describe('managed rename recovery journal — v2 round-trip', () => {
  test('writes the journal before mutations and clears it after success', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'alpha.md'), '# Alpha\n', 'utf-8');

    let sawJournalBeforeMutation = false;
    await withManagedRenameRecovery(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'alpha',
        toPath: 'beta',
        affectedDocs: [{ from: 'alpha', to: 'beta' }],
        snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
      }),
      () => {
        sawJournalBeforeMutation = existsSync(managedRenameJournalPath(dir));
        renameSync(join(dir, 'alpha.md'), join(dir, 'beta.md'));
      },
    );

    expect(sawJournalBeforeMutation).toBe(true);
    expect(existsSync(managedRenameJournalPath(dir))).toBe(false);
    expect(existsSync(join(dir, 'alpha.md'))).toBe(false);
    expect(readFileSync(join(dir, 'beta.md'), 'utf-8')).toBe('# Alpha\n');
  });

  test('writes a journal with version 2 on disk', () => {
    const dir = setupTmpDir();
    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'alpha',
      toPath: 'beta',
      affectedDocs: [{ from: 'alpha', to: 'beta' }],
      snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
    });
    writeManagedRenameJournal(dir, journal);

    const onDisk = JSON.parse(readFileSync(managedRenameJournalPath(dir), 'utf-8'));
    expect(onDisk.version).toBe(2);
    expect(onDisk.fromPath).toBe('alpha');
    expect(onDisk.toPath).toBe('beta');
    expect(onDisk.affectedDocs).toEqual([{ from: 'alpha', to: 'beta' }]);
  });

  test('readManagedRenameJournal round-trips a v2 journal', () => {
    const dir = setupTmpDir();
    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'articles',
      toPath: 'essays',
      affectedDocs: [
        { from: 'articles/auth', to: 'essays/auth' },
        { from: 'articles/login', to: 'essays/login' },
      ],
      snapshots: [
        { docName: 'articles/auth', content: '# Auth\n' },
        { docName: 'articles/login', content: '# Login\n' },
      ],
    });
    writeManagedRenameJournal(dir, journal);

    const parsed = readManagedRenameJournal(dir);
    expect(parsed?.version).toBe(2);
    if (parsed?.version === 2) {
      expect(parsed.fromPath).toBe('articles');
      expect(parsed.affectedDocs).toHaveLength(2);
    }
  });
});

describe('managed rename recovery journal — v2 multi-doc recovery', () => {
  test('replays multiple affected docs and removes all destination paths', () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'beta.md'), '# Alpha\n', 'utf-8');
    writeFileSync(join(dir, 'gamma.md'), '# Bravo\n', 'utf-8');
    writeFileSync(join(dir, 'referrer.md'), 'See [[beta]].\n', 'utf-8');

    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'group',
      toPath: 'team',
      affectedDocs: [
        { from: 'alpha', to: 'beta' },
        { from: 'bravo', to: 'gamma' },
      ],
      snapshots: [
        { docName: 'alpha', content: '# Alpha\n' },
        { docName: 'bravo', content: '# Bravo\n' },
        { docName: 'referrer', content: 'See [[alpha]].\n' },
      ],
    });
    writeManagedRenameJournal(dir, journal);

    const recovery = recoverPendingManagedRename(dir);
    expect(recovery.recovered).toBe(true);
    expect(recovery.restoredDocNames).toEqual(['alpha', 'bravo', 'referrer']);
    expect(readFileSync(join(dir, 'alpha.md'), 'utf-8')).toBe('# Alpha\n');
    expect(readFileSync(join(dir, 'bravo.md'), 'utf-8')).toBe('# Bravo\n');
    expect(readFileSync(join(dir, 'referrer.md'), 'utf-8')).toBe('See [[alpha]].\n');
    expect(existsSync(join(dir, 'beta.md'))).toBe(false);
    expect(existsSync(join(dir, 'gamma.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(dir))).toBe(false);
  });

  test('keeps the journal on disk when the operation throws', async () => {
    const dir = setupTmpDir();
    await expect(
      withManagedRenameRecovery(
        dir,
        createManagedRenameRecoveryJournal({
          fromPath: 'alpha',
          toPath: 'beta',
          affectedDocs: [{ from: 'alpha', to: 'beta' }],
          snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
        }),
        () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(managedRenameJournalPath(dir))).toBe(true);
  });

  test('keeps the journal when recovery cannot restore every snapshot', () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'beta.md'), '# Alpha\n', 'utf-8');

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'alpha',
        toPath: 'beta',
        affectedDocs: [{ from: 'alpha', to: 'beta' }],
        snapshots: [
          { docName: 'alpha', content: '# Alpha\n' },
          { docName: '../escape', content: 'bad\n' },
        ],
      }),
    );

    expect(() => recoverPendingManagedRename(dir)).toThrow(
      'Managed rename recovery incomplete; failed to restore: ../escape',
    );
    expect(readFileSync(join(dir, 'alpha.md'), 'utf-8')).toBe('# Alpha\n');
    expect(existsSync(join(dir, 'beta.md'))).toBe(true);
    expect(existsSync(managedRenameJournalPath(dir))).toBe(true);
  });

  test('preserves a destination that also appears as a source (rename chain)', () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'b.md'), '# A content\n', 'utf-8');
    writeFileSync(join(dir, 'c.md'), '# B content\n', 'utf-8');

    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'group',
      toPath: 'team',
      affectedDocs: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
      snapshots: [
        { docName: 'a', content: '# A content\n' },
        { docName: 'b', content: '# B content\n' },
      ],
    });
    writeManagedRenameJournal(dir, journal);

    const recovery = recoverPendingManagedRename(dir);
    expect(recovery.recovered).toBe(true);
    expect(readFileSync(join(dir, 'a.md'), 'utf-8')).toBe('# A content\n');
    expect(readFileSync(join(dir, 'b.md'), 'utf-8')).toBe('# B content\n');
    expect(existsSync(join(dir, 'c.md'))).toBe(false);
  });

  test('removes empty destination parent directories left behind by a folder rename', () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'essays'), { recursive: true });
    writeFileSync(join(dir, 'essays', 'auth.md'), '# Auth\n', 'utf-8');
    writeFileSync(join(dir, 'essays', 'login.md'), '# Login\n', 'utf-8');

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'articles',
        toPath: 'essays',
        affectedDocs: [
          { from: 'articles/auth', to: 'essays/auth' },
          { from: 'articles/login', to: 'essays/login' },
        ],
        snapshots: [
          { docName: 'articles/auth', content: '# Auth\n' },
          { docName: 'articles/login', content: '# Login\n' },
        ],
      }),
    );

    const recovery = recoverPendingManagedRename(dir);
    expect(recovery.recovered).toBe(true);
    expect(readFileSync(join(dir, 'articles', 'auth.md'), 'utf-8')).toBe('# Auth\n');
    expect(readFileSync(join(dir, 'articles', 'login.md'), 'utf-8')).toBe('# Login\n');
    expect(existsSync(join(dir, 'essays', 'auth.md'))).toBe(false);
    expect(existsSync(join(dir, 'essays', 'login.md'))).toBe(false);
    expect(existsSync(join(dir, 'essays'))).toBe(false);
  });

  test('preserves a non-empty destination parent that holds unrelated files', () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'essays'), { recursive: true });
    writeFileSync(join(dir, 'essays', 'auth.md'), '# Auth\n', 'utf-8');
    writeFileSync(join(dir, 'essays', 'unrelated.md'), '# Unrelated\n', 'utf-8');

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'articles/auth',
        toPath: 'essays/auth',
        affectedDocs: [{ from: 'articles/auth', to: 'essays/auth' }],
        snapshots: [{ docName: 'articles/auth', content: '# Auth\n' }],
      }),
    );

    recoverPendingManagedRename(dir);
    expect(existsSync(join(dir, 'essays', 'unrelated.md'))).toBe(true);
    expect(existsSync(join(dir, 'essays'))).toBe(true);
  });

  test('replays path snapshots and removes path-level cleanup targets', () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'guide.md'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, 'docs', 'guide.txt'), '# Guide\n', 'utf-8');

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'docs/guide.txt',
        toPath: 'docs/guide.md',
        affectedDocs: [],
        snapshots: [],
        pathSnapshots: [{ path: 'docs/guide.txt', content: '# Guide\n' }],
        cleanupPaths: ['docs/guide.md'],
      }),
    );

    const recovery = recoverPendingManagedRename(dir);
    expect(recovery.recovered).toBe(true);
    expect(recovery.restoredDocNames).toEqual([]);
    expect(readFileSync(join(dir, 'docs', 'guide.txt'), 'utf-8')).toBe('# Guide\n');
    expect(existsSync(join(dir, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(dir))).toBe(false);
  });

  test('keeps the journal when a path-level cleanup target is invalid', () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'docs/guide.txt',
        toPath: 'docs/guide.md',
        affectedDocs: [],
        snapshots: [],
        pathSnapshots: [{ path: 'docs/guide.txt', content: '# Guide\n' }],
        cleanupPaths: ['../escape.md'],
      }),
    );

    expect(() => recoverPendingManagedRename(dir)).toThrow(
      'Managed rename recovery incomplete; failed to clean destinations: ../escape.md',
    );
    expect(readFileSync(join(dir, 'docs', 'guide.txt'), 'utf-8')).toBe('# Guide\n');
    expect(existsSync(managedRenameJournalPath(dir))).toBe(true);
  });
});

describe('managed rename recovery journal — failure cause propagation', () => {
  test('thrown summary on snapshot restore failure carries underlying causes', () => {
    const dir = setupTmpDir();

    writeManagedRenameJournal(
      dir,
      createManagedRenameRecoveryJournal({
        fromPath: 'alpha',
        toPath: 'beta',
        affectedDocs: [{ from: 'alpha', to: 'beta' }],
        snapshots: [
          { docName: 'alpha', content: '# Alpha\n' },
          { docName: '../escape', content: 'bad\n' },
        ],
      }),
    );

    let captured: unknown;
    try {
      recoverPendingManagedRename(dir);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(AggregateError);
    if (captured instanceof AggregateError) {
      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(Error);
    }
  });
});

describe('managed rename recovery journal — v1 legacy support', () => {
  test('readManagedRenameJournal parses a v1 journal at startup', () => {
    const dir = setupTmpDir();
    const v1Journal = {
      version: 1,
      sourceDocName: 'alpha',
      destinationDocName: 'beta',
      createdAt: '2026-04-29T10:00:00.000Z',
      snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
    };
    mkdirSync(dirname(managedRenameJournalPath(dir)), { recursive: true });
    writeFileSync(managedRenameJournalPath(dir), JSON.stringify(v1Journal), 'utf-8');

    const parsed = readManagedRenameJournal(dir);
    expect(parsed?.version).toBe(1);
    if (parsed?.version === 1) {
      expect(parsed.sourceDocName).toBe('alpha');
      expect(parsed.destinationDocName).toBe('beta');
    }
  });

  test('recoverPendingManagedRename restores a v1 journal at startup', () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'beta.md'), '# Alpha\n', 'utf-8');
    writeFileSync(join(dir, 'referrer.md'), 'See [[beta]].\n', 'utf-8');

    const v1Journal = {
      version: 1,
      sourceDocName: 'alpha',
      destinationDocName: 'beta',
      createdAt: '2026-04-29T10:00:00.000Z',
      snapshots: [
        { docName: 'alpha', content: '# Alpha\n' },
        { docName: 'referrer', content: 'See [[alpha]].\n' },
      ],
    };
    mkdirSync(dirname(managedRenameJournalPath(dir)), { recursive: true });
    writeFileSync(managedRenameJournalPath(dir), JSON.stringify(v1Journal), 'utf-8');

    const recovery = recoverPendingManagedRename(dir);
    expect(recovery.recovered).toBe(true);
    expect(recovery.restoredDocNames).toEqual(['alpha', 'referrer']);
    expect(readFileSync(join(dir, 'alpha.md'), 'utf-8')).toBe('# Alpha\n');
    expect(readFileSync(join(dir, 'referrer.md'), 'utf-8')).toBe('See [[alpha]].\n');
    expect(existsSync(join(dir, 'beta.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(dir))).toBe(false);
  });

  test('rejects journals with unsupported version', () => {
    const dir = setupTmpDir();
    mkdirSync(dirname(managedRenameJournalPath(dir)), { recursive: true });
    writeFileSync(
      managedRenameJournalPath(dir),
      JSON.stringify({ version: 99, snapshots: [] }),
      'utf-8',
    );
    expect(() => readManagedRenameJournal(dir)).toThrow(
      'Unsupported managed rename journal version',
    );
  });
});

describe('managed rename recovery journal — v2 parser validation', () => {
  function writeRawJournal(dir: string, payload: unknown) {
    mkdirSync(dirname(managedRenameJournalPath(dir)), { recursive: true });
    writeFileSync(managedRenameJournalPath(dir), JSON.stringify(payload), 'utf-8');
  }

  test('rejects v2 journals missing fromPath', () => {
    const dir = setupTmpDir();
    writeRawJournal(dir, {
      version: 2,
      toPath: 'beta',
      createdAt: '2026-04-30T00:00:00.000Z',
      affectedDocs: [{ from: 'alpha', to: 'beta' }],
      snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
    });
    expect(() => readManagedRenameJournal(dir)).toThrow(
      'Managed rename journal v2 is missing fromPath',
    );
  });

  test('rejects v2 journals with empty affectedDocs', () => {
    const dir = setupTmpDir();
    writeRawJournal(dir, {
      version: 2,
      fromPath: 'alpha',
      toPath: 'beta',
      createdAt: '2026-04-30T00:00:00.000Z',
      affectedDocs: [],
      snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
    });
    expect(() => readManagedRenameJournal(dir)).toThrow(
      'Managed rename journal v2 has invalid affectedDocs',
    );
  });

  test('rejects v2 journals where an affectedDoc lacks a matching snapshot', () => {
    const dir = setupTmpDir();
    writeRawJournal(dir, {
      version: 2,
      fromPath: 'alpha',
      toPath: 'beta',
      createdAt: '2026-04-30T00:00:00.000Z',
      affectedDocs: [
        { from: 'alpha', to: 'beta' },
        { from: 'orphan', to: 'orphan-renamed' },
      ],
      snapshots: [{ docName: 'alpha', content: '# Alpha\n' }],
    });
    expect(() => readManagedRenameJournal(dir)).toThrow(
      'Managed rename journal v2 is missing snapshot for affected doc: orphan',
    );
  });

  test('rejects v2 journals with malformed snapshot entries', () => {
    const dir = setupTmpDir();
    writeRawJournal(dir, {
      version: 2,
      fromPath: 'alpha',
      toPath: 'beta',
      createdAt: '2026-04-30T00:00:00.000Z',
      affectedDocs: [{ from: 'alpha', to: 'beta' }],
      snapshots: [{ docName: 'alpha' }],
    });
    expect(() => readManagedRenameJournal(dir)).toThrow(
      'Managed rename journal v2 has invalid snapshots',
    );
  });

  test('accepts v2 path-only journals for cross-type file recovery', () => {
    const dir = setupTmpDir();
    writeRawJournal(dir, {
      version: 2,
      fromPath: 'docs/guide.txt',
      toPath: 'docs/guide.md',
      createdAt: '2026-04-30T00:00:00.000Z',
      affectedDocs: [],
      snapshots: [],
      pathSnapshots: [{ path: 'docs/guide.txt', content: '# Guide\n' }],
      cleanupPaths: ['docs/guide.md'],
    });

    const parsed = readManagedRenameJournal(dir);
    expect(parsed?.version).toBe(2);
    if (parsed?.version === 2) {
      expect(parsed.pathSnapshots).toEqual([{ path: 'docs/guide.txt', content: '# Guide\n' }]);
      expect(parsed.cleanupPaths).toEqual(['docs/guide.md']);
    }
  });
});
