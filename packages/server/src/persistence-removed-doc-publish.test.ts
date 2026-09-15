import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import * as fsTraced from './fs-traced.ts';
import { getMetrics } from './metrics.ts';
import { createPersistenceExtension } from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

const SEEDED = 'alpha\n\nbeta\n';

function appendUnflushedEdit(document: Y.Doc): void {
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText('pending edit')]);
  fragment.insert(fragment.length, [paragraph]);
  ytext.insert(ytext.length, '\npending edit\n');
}

function refusalEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map(([arg]) => (typeof arg === 'string' ? arg : ''))
    .filter((arg) => arg.includes('"event":"persistence-store-removed-doc"'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

describe('persistence publish guard — a removed document is never republished', () => {
  let tmpDir: string;
  let docName: string;
  let docPath: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;

  function persistenceWith(isRecentlyRemoved?: (name: string) => boolean) {
    return createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
      ...(isRecentlyRemoved ? { isRecentlyRemoved } : {}),
    });
  }

  async function loadFromDisk(persistence: ReturnType<typeof persistenceWith>): Promise<void> {
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);
    expect(durabilityState.getReconciledBase(docName)).toBe(SEEDED);
  }

  async function store(persistence: ReturnType<typeof persistenceWith>): Promise<void> {
    await persistence.extension.onStoreDocument?.({
      document,
      documentName: docName,
      lastTransactionOrigin: BROWSER_ORIGIN,
      lastContext: {},
    } as never);
  }

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-removed-publish-')));
    docName = 'removed-doc';
    docPath = join(tmpDir, `${docName}.md`);
    document = new Y.Doc();
    durabilityState = new DocumentDurabilityState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('does not recreate a file deleted before the store began', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    rmSync(docPath);

    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
  });

  test('does not recreate a file deleted while the store was already in flight', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    queueMicrotask(() => rmSync(docPath));
    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
    expect(refusalEvents(warn).at(-1)?.reason).toBe('file-absent');
  });

  test('names the watcher record as the reason, and the bytes it refused', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith(() => true);
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = getMetrics().persistenceStoreRemovedDocCount;
    rmSync(docPath);

    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
    expect(getMetrics().persistenceStoreRemovedDocCount).toBe(before + 1);
    const event = refusalEvents(warn).at(-1);
    expect(event?.['doc.name']).toBe(docName);
    expect(event?.reason).toBe('recently-removed');
    expect(event?.baseBytes).toBe(SEEDED.length);
    expect(event?.candidateBytes).toBeGreaterThan(SEEDED.length);
  });

  test('still publishes when the watcher record is stale and the file is on disk', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith(() => true);
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);

    await store(persistence);

    expect(readFileSync(docPath, 'utf-8')).toContain('pending edit');
  });

  test('reports the refusal to a caller awaiting the flush', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(docPath);
    durabilityState.markAgentWriteStore(docName);

    await store(persistence);

    expect(durabilityState.takeStoreFailure(docName)?.code).toBe('OK_DOC_REMOVED');
  });

  test('records no flush outcome when nobody was awaiting the refused store', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(docPath);

    await store(persistence);

    expect(durabilityState.takeStoreFailure(docName)).toBeNull();
  });

  test('does not recreate the folder of a document removed with its directory', async () => {
    docName = 'folder/removed-doc';
    docPath = join(tmpDir, `${docName}.md`);
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    rmSync(dirname(docPath), { recursive: true });

    await store(persistence);

    expect(existsSync(dirname(docPath))).toBe(false);
  });

  test('refuses, and leaves the link intact, when the symlink target has gone', async () => {
    const targetPath = join(tmpDir, 'target.md');
    writeFileSync(targetPath, SEEDED, 'utf-8');
    symlinkSync(targetPath, docPath);
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(targetPath);

    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
    expect(lstatSync(docPath).isSymbolicLink()).toBe(true);
    expect(refusalEvents(warn).at(-1)?.reason).toBe('file-absent');
  });

  test('refuses after a branch switch has dropped the reconciled base', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    durabilityState.switchReconciledBaseScope('feature');
    expect(durabilityState.getReconciledBase(docName)).toBeUndefined();
    rmSync(docPath);

    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
  });

  test('does not recreate a file deleted between the temp write and the rename', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realWriteFile = fsTraced.tracedWriteFile;
    vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (path, data, options) => {
      await realWriteFile(path, data, options);
      if (typeof path === 'string' && path.startsWith(`${docPath}.tmp.`)) rmSync(docPath);
    });

    await store(persistence);

    expect(existsSync(docPath)).toBe(false);
    expect(readdirSync(tmpDir).filter((name) => name.includes('.tmp.'))).toEqual([]);
    expect(refusalEvents(warn).at(-1)?.reason).toBe('file-absent');
  });

  test('refuses when the document folder is reoccupied by a file', async () => {
    docName = 'folder/removed-doc';
    docPath = join(tmpDir, `${docName}.md`);
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(dirname(docPath), { recursive: true });
    writeFileSync(dirname(docPath), 'reoccupied\n', 'utf-8');
    durabilityState.markAgentWriteStore(docName);

    await store(persistence);

    expect(readFileSync(dirname(docPath), 'utf-8')).toBe('reoccupied\n');
    expect(refusalEvents(warn).at(-1)?.reason).toBe('file-absent');
    expect(durabilityState.takeStoreFailure(docName)?.code).toBe('OK_DOC_REMOVED');
  });

  test('records a probe error the caller cannot read as a clean flush', async () => {
    docName = 'a/doc';
    docPath = join(tmpDir, 'a', 'doc.md');
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    rmSync(join(tmpDir, 'a'), { recursive: true });
    symlinkSync(join(tmpDir, 'b'), join(tmpDir, 'a'));
    symlinkSync(join(tmpDir, 'a'), join(tmpDir, 'b'));
    durabilityState.markAgentWriteStore(docName);

    await expect(store(persistence)).rejects.toThrow(/ELOOP/);

    expect(durabilityState.takeStoreFailure(docName)?.code).toBe('OK_PATH_UNRESOLVABLE');
  });

  test('records a probe error when the document path itself is a symlink cycle', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    rmSync(docPath);
    symlinkSync(join(tmpDir, 'cycle.md'), docPath);
    symlinkSync(docPath, join(tmpDir, 'cycle.md'));
    durabilityState.markAgentWriteStore(docName);

    await expect(store(persistence)).rejects.toThrow(/ELOOP/);

    expect(durabilityState.takeStoreFailure(docName)?.code).toBe('OK_PATH_UNRESOLVABLE');
    expect(lstatSync(docPath).isSymbolicLink()).toBe(true);
  });

  test('refuses, and leaves the link intact, when the symlink resolves through a file', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rmSync(docPath);
    const regularPath = join(tmpDir, 'regular.md');
    writeFileSync(regularPath, 'x', 'utf-8');
    symlinkSync(join(regularPath, 'sub.md'), docPath);
    durabilityState.markAgentWriteStore(docName);

    await store(persistence);

    expect(refusalEvents(warn).at(-1)?.reason).toBe('file-absent');
    expect(durabilityState.takeStoreFailure(docName)?.code).toBe('OK_DOC_REMOVED');
    expect(lstatSync(docPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(regularPath, 'utf-8')).toBe('x');
  });

  test('records one path-fault classification when a cycle blocks a first write', async () => {
    symlinkSync(join(tmpDir, 'cycle.md'), docPath);
    symlinkSync(docPath, join(tmpDir, 'cycle.md'));
    const persistence = persistenceWith();

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    expect(durabilityState.getReconciledBase(docName)).toBeUndefined();
    durabilityState.markAgentWriteStore(docName);

    await expect(store(persistence)).rejects.toThrow(/Symlink cycle detected/);

    const failure = durabilityState.takeStoreFailure(docName);
    expect(failure?.code).toBe('OK_PATH_UNRESOLVABLE');
    expect(failure?.message).not.toContain(tmpDir);
  });

  test('records no path fault for a first write nobody was awaiting', async () => {
    symlinkSync(join(tmpDir, 'cycle.md'), docPath);
    symlinkSync(docPath, join(tmpDir, 'cycle.md'));
    const persistence = persistenceWith();

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);

    await expect(store(persistence)).rejects.toThrow(/Symlink cycle detected/);

    expect(durabilityState.takeStoreFailure(docName)).toBeNull();
  });

  test('keeps the path-fault record when the fault appears between the temp write and the rename', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    durabilityState.markAgentWriteStore(docName);
    const realWriteFile = fsTraced.tracedWriteFile;
    vi.spyOn(fsTraced, 'tracedWriteFile').mockImplementation(async (path, data, options) => {
      await realWriteFile(path, data, options);
      if (typeof path === 'string' && path.startsWith(`${docPath}.tmp.`)) {
        rmSync(docPath);
        symlinkSync(join(tmpDir, 'cycle.md'), docPath);
        symlinkSync(docPath, join(tmpDir, 'cycle.md'));
      }
    });

    await expect(store(persistence)).rejects.toThrow();

    const failure = durabilityState.takeStoreFailure(docName);
    expect(failure?.code).toBe('OK_PATH_UNRESOLVABLE');
    expect(failure?.message).not.toContain(tmpDir);
  });

  test('still creates the file for a document that never had one', async () => {
    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    expect(durabilityState.getReconciledBase(docName)).toBeUndefined();

    await store(persistenceWith());

    expect(readFileSync(docPath, 'utf-8')).toContain('pending edit');
  });

  test('recreates a document that was removed after it had been loaded from disk', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    rmSync(docPath);
    durabilityState.deleteReconciledBase(docName);
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    await store(persistence);

    expect(readFileSync(docPath, 'utf-8')).toContain('pending edit');
  });

  test('recreates a document whose file was renamed away while it stayed resident', async () => {
    writeFileSync(docPath, SEEDED, 'utf-8');
    const persistence = persistenceWith();
    await loadFromDisk(persistence);

    renameSync(docPath, join(tmpDir, 'renamed-doc.md'));
    durabilityState.deleteReconciledBase(docName);
    persistence.forgetObservedFile(docName);

    document.transact(() => appendUnflushedEdit(document), BROWSER_ORIGIN);
    await store(persistence);

    expect(readFileSync(docPath, 'utf-8')).toContain('pending edit');
  });
});
