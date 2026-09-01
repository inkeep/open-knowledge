import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import type { PairedWriteOrigin } from '../server-observers.ts';
import type { WriterIdentity } from '../shadow-repo.ts';
import { type GeneratedArtifactEnv, writeGeneratedArtifact } from './generated-artifact.ts';

const WRITER: WriterIdentity = {
  id: 'ok-generator',
  name: 'OpenKnowledge (generated)',
  email: 'ok-generator@openknowledge.local',
};

const ORIGIN = Object.freeze({
  source: 'local' as const,
  skipStoreHooks: false,
  context: Object.freeze({ origin: 'generated-test', paired: true as const }),
}) satisfies PairedWriteOrigin;

interface Recorded {
  disk: Array<{ absPath: string; markdown: string }>;
  registered: string[];
  indexed: Array<{ kind: 'create' | 'update'; docName: string }>;
  signals: number;
  attributed: Array<{ docName: string; writer: string }>;
}

function harness(document?: Y.Doc): { env: GeneratedArtifactEnv; rec: Recorded } {
  const rec: Recorded = {
    disk: [],
    registered: [],
    indexed: [],
    signals: 0,
    attributed: [],
  };
  const env: GeneratedArtifactEnv = {
    origin: ORIGIN,
    writer: WRITER,
    isConflict: () => false,
    getDocument: () => document,
    writeDisk: (absPath, markdown) => rec.disk.push({ absPath, markdown }),
    registerWrite: (absPath) => rec.registered.push(absPath),
    noteFileIndex: (e) => rec.indexed.push({ kind: e.kind, docName: e.docName }),
    signalFiles: () => {
      rec.signals += 1;
    },
    attribute: async (docName, writer) => {
      rec.attributed.push({ docName, writer: writer.id });
    },
  };
  return { env, rec };
}

const WRITE = {
  docName: 'index',
  absPath: '/project/content/index.md',
  markdown: '# Index\n\n* [A](./a.md)\n',
};

describe('writeGeneratedArtifact', () => {
  test('a tracked conflict blocks an unloaded artifact without side effects', async () => {
    const { env, rec } = harness();
    env.isConflict = (docName) => docName === WRITE.docName;

    const outcome = await writeGeneratedArtifact(
      { ...WRITE, currentMarkdown: '# Conflict bytes\n' },
      env,
    );

    expect(outcome).toBe('blocked-conflict');
    expect(rec).toEqual({ disk: [], registered: [], indexed: [], signals: 0, attributed: [] });
  });

  test('identical bytes perform no write at all', async () => {
    const { env, rec } = harness();

    const outcome = await writeGeneratedArtifact(
      { ...WRITE, currentMarkdown: WRITE.markdown },
      env,
    );

    expect(outcome).toBe('unchanged');
    expect(rec).toEqual({ disk: [], registered: [], indexed: [], signals: 0, attributed: [] });
  });

  test('an unloaded artifact goes to disk with its full bookkeeping', async () => {
    const { env, rec } = harness();

    const outcome = await writeGeneratedArtifact({ ...WRITE, currentMarkdown: null }, env);

    expect(outcome).toBe('disk');
    expect(rec.disk).toEqual([{ absPath: WRITE.absPath, markdown: WRITE.markdown }]);
    expect(rec.registered).toEqual([WRITE.absPath]);
    expect(rec.signals).toBe(1);
  });

  test('a first write is a create and a rewrite is an update', async () => {
    const first = harness();
    await writeGeneratedArtifact({ ...WRITE, currentMarkdown: null }, first.env);
    expect(first.rec.indexed).toEqual([{ kind: 'create', docName: 'index' }]);

    const second = harness();
    await writeGeneratedArtifact({ ...WRITE, currentMarkdown: '# Stale\n' }, second.env);
    expect(second.rec.indexed).toEqual([{ kind: 'update', docName: 'index' }]);
  });

  test('a loaded artifact is written through the document, not to disk', async () => {
    const doc = new Y.Doc();
    const { env, rec } = harness(doc);

    const outcome = await writeGeneratedArtifact({ ...WRITE, currentMarkdown: '# Stale\n' }, env);

    expect(outcome).toBe('document');
    expect(rec.disk).toEqual([]);
    expect(rec.registered).toEqual([]);
    expect(rec.indexed).toEqual([]);
    expect(doc.getText('source').toString()).toContain('[A](./a.md)');
  });

  test('both paths attribute the write, to the same writer', async () => {
    const unloaded = harness();
    await writeGeneratedArtifact({ ...WRITE, currentMarkdown: null }, unloaded.env);

    const loaded = harness(new Y.Doc());
    await writeGeneratedArtifact({ ...WRITE, currentMarkdown: '# Stale\n' }, loaded.env);

    const expected = [{ docName: 'index', writer: 'ok-generator' }];
    expect(unloaded.rec.attributed).toEqual(expected);
    expect(loaded.rec.attributed).toEqual(expected);
  });

  test('the CRDT write carries the paired origin it was given', async () => {
    const doc = new Y.Doc();
    const { env } = harness(doc);
    const origins: unknown[] = [];
    doc.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin));

    await writeGeneratedArtifact({ ...WRITE, currentMarkdown: '# Stale\n' }, env);

    expect(origins).toContain(ORIGIN);
  });

  test('resident CRDT bytes are authoritative over an equal disk snapshot', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, '# Unsaved human edit\n');
    const { env, rec } = harness(doc);

    const outcome = await writeGeneratedArtifact(
      { ...WRITE, currentMarkdown: WRITE.markdown },
      env,
    );

    expect(outcome).toBe('document');
    expect(doc.getText('source').toString()).toBe(WRITE.markdown);
    expect(rec.attributed).toEqual([{ docName: 'index', writer: 'ok-generator' }]);
  });

  test('resident matching bytes settle even when the disk snapshot is stale', async () => {
    const doc = new Y.Doc();
    doc.getText('source').insert(0, WRITE.markdown);
    const { env, rec } = harness(doc);

    const outcome = await writeGeneratedArtifact(
      { ...WRITE, currentMarkdown: '# Stale on disk\n' },
      env,
    );

    expect(outcome).toBe('unchanged');
    expect(rec).toEqual({ disk: [], registered: [], indexed: [], signals: 0, attributed: [] });
  });

  test('awaits an asynchronous disk publication before bookkeeping and attribution', async () => {
    const { env, rec } = harness();
    let release!: () => void;
    env.writeDisk = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      rec.disk.push({ absPath: WRITE.absPath, markdown: WRITE.markdown });
    };

    const pending = writeGeneratedArtifact({ ...WRITE, currentMarkdown: null }, env);
    await Promise.resolve();
    expect(rec.registered).toEqual([]);
    expect(rec.attributed).toEqual([]);

    release();
    await expect(pending).resolves.toBe('disk');
    expect(rec.registered).toEqual([WRITE.absPath]);
    expect(rec.attributed).toEqual([{ docName: 'index', writer: 'ok-generator' }]);
  });
});
