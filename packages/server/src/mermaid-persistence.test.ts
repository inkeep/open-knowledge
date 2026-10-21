import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fnv1aDigest, LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DiskReceiptLog } from './disk-receipts.ts';
import * as fsTraced from './fs-traced.ts';
import { tracedAtomicFs } from './fs-traced.ts';
import type { EnginelessFileType, KeptCopy } from './merge-history.ts';
import {
  applyExternalEnginelessChange,
  loadMermaidDoc,
  MERMAID_SOURCE_ORIGIN,
  type MermaidPersistenceCtx,
  storeMermaidDoc,
} from './mermaid-persistence.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { assertServerContentPath, snapshotServerContentScope } from './server-content-policy.ts';
import { contentHash } from './version-hash.ts';

let contentDir: string;
let home: string;

interface MovedVersion {
  docName: string;
  side: 'ours' | 'theirs';
  bytes: string;
  fileType: string;
}

interface RecordedNotice {
  docName: string;
  side: 'ours' | 'theirs';
  fileType: string;
  copy: KeptCopy;
}

type RecordingCtx = MermaidPersistenceCtx & {
  receipts: DiskReceiptLog;
  moved: MovedVersion[];
  notices: RecordedNotice[];
};

function makeCtx(
  options: { historySaves?: boolean; noHistory?: boolean; duringSave?: () => void } = {},
): RecordingCtx {
  const moved: MovedVersion[] = [];
  const notices: RecordedNotice[] = [];
  return {
    contentDir,
    home,
    lkgCache: new Map<string, string>(),
    receipts: new DiskReceiptLog(),
    moved,
    notices,
    history: options.noHistory
      ? null
      : {
          saveNoEngine: async (docName, displaced, fileType) => {
            options.duringSave?.();
            if (options.historySaves === false) return null;
            moved.push({ docName, ...displaced, fileType });
            return `entry-${moved.length}`;
          },
          noticeNoEngine: (docName, side, fileType, copy) => {
            notices.push({ docName, side, fileType, copy });
          },
        },
  };
}

function backupsFor(docName: string): string[] {
  const dir = join(
    home,
    '.ok',
    'edit-backups',
    'discarded',
    'projects',
    fnv1aDigest(contentDir),
    docName.replace(/[^A-Za-z0-9._-]+/g, '__'),
  );
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf-8'));
}

function blockBackups(): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'edit-backups'), 'not a folder');
}

const DOC = 'assets/flow.mmd';
const ABS = () => resolve(contentDir, DOC);
const SRC = 'graph TD;\n  A[Start] --> B{Choice};\n  B -->|Yes| C[Go];\n';

function writeMmd(content: string): void {
  mkdirSync(dirname(ABS()), { recursive: true });
  writeFileSync(ABS(), content, 'utf-8');
}

beforeEach(() => {
  contentDir = mkdtempSync(join(tmpdir(), 'ok-mermaid-'));
  home = mkdtempSync(join(tmpdir(), 'ok-mermaid-home-'));
  resetMetrics();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(contentDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('storeMermaidDoc', () => {
  test('refuses a nested project created between staging and publishing verbatim content', async () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const scope = snapshotServerContentScope(contentDir);
    ctx.assertContentPath = (path) => assertServerContentPath(scope, path);
    ctx.lkgCache.set(DOC, SRC);
    const doc = new Y.Doc();
    doc.getText('source').insert(0, 'graph TD; After-->Change;\n');
    const write = tracedAtomicFs.writeFile;
    const staged = vi.spyOn(tracedAtomicFs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      mkdirSync(join(contentDir, 'assets', '.ok'));
      writeFileSync(join(contentDir, 'assets', '.ok', 'config.yml'), '');
    });
    try {
      expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('write-failed');
      expect(readFileSync(ABS(), 'utf8')).toBe(SRC);
      expect(ctx.lkgCache.get(DOC)).toBe(SRC);
      expect(
        readdirSync(join(contentDir, 'assets')).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    } finally {
      staged.mockRestore();
      doc.destroy();
    }
  });

  test('persists Y.Text("source") verbatim to the .mmd file', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(ABS(), 'utf-8')).toBe(SRC);
  });

  test('stores source with markdown-syntactic + blank-line content byte-for-byte (no remark round-trip)', async () => {
    const ctx = makeCtx();
    const awkward = '## not a heading\n\n\n> not a quote  \ngraph LR; A-->B;\n';
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, awkward), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(ABS(), 'utf-8')).toBe(awkward);
  });

  test('no-op when the store originates from a seed/reconcile import (skip-store origin)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, MERMAID_SOURCE_ORIGIN, ctx)).toBe('no-op');
  });

  test('no-op on the second identical store (LKG equality guard)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('no-op');
  });

  test('records an own-write receipt for the bytes it wrote', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(ctx.receipts.get(DOC)).toMatchObject({ hash: contentHash(SRC), via: 'own-write' });
    expect(ctx.receipts.isRecentOwnWrite(DOC, contentHash(SRC))).toBe(true);
  });

  test('writes when disk still holds the last saved version though the receipt moved on', async () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, DOC, ctx);
    ctx.receipts.recordAgreed(DOC, 'graph TD; Elsewhere;\n');
    doc.transact(() => doc.getText('source').insert(0, '%% edited\n'), 'agent');
    expect(await storeMermaidDoc(doc, DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(ABS(), 'utf-8')).toBe(`%% edited\n${SRC}`);
    expect(ctx.moved).toEqual([]);
  });
});

const ENGINELESS_CASES: ReadonlyArray<{
  docName: string;
  fileType: EnginelessFileType;
  saved: string;
  here: string;
  outside: string;
}> = [
  {
    docName: 'diagrams/flow.mmd',
    fileType: 'mermaid',
    saved: 'graph TD\n  A-->B\n',
    here: 'graph TD\n  A-->C\n',
    outside: 'graph TD\n  A-->D\n',
  },
  {
    docName: 'boards/plan.excalidraw',
    fileType: 'excalidraw',
    saved: '{"type":"excalidraw","elements":[{"id":"a","x":0}]}\n',
    here: '{"type":"excalidraw","elements":[{"id":"a","x":10}]}\n',
    outside: '{"type":"excalidraw","elements":[{"id":"a","x":20}]}\n',
  },
  {
    docName: 'src/value.ts',
    fileType: 'text',
    saved: 'export const value = 1;\n',
    here: 'export const value = 2;\n',
    outside: 'export const value = 3;\n',
  },
];

function writeDocFile(docName: string, content: string): void {
  const abs = resolve(contentDir, docName);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readDocFile(docName: string): string {
  return readFileSync(resolve(contentDir, docName), 'utf-8');
}

function editTo(doc: Y.Doc, text: string): void {
  doc.transact(() => {
    const ytext = doc.getText('source');
    ytext.delete(0, ytext.length);
    ytext.insert(0, text);
  }, 'person');
}

function openWithUnsavedEdit(
  kase: (typeof ENGINELESS_CASES)[number],
  ctx: RecordingCtx,
): { doc: Y.Doc; undo: Y.UndoManager } {
  writeDocFile(kase.docName, kase.saved);
  const doc = new Y.Doc();
  loadMermaidDoc(doc, kase.docName, ctx);
  const undo = new Y.UndoManager(doc.getText('source'), { trackedOrigins: new Set(['person']) });
  editTo(doc, kase.here);
  return { doc, undo };
}

describe.each(ENGINELESS_CASES)('an outside write under unsaved edits to $docName', (kase) => {
  test('keeps the version here live and on disk and moves the outside version to history', async () => {
    const ctx = makeCtx();
    const { doc, undo } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('kept-live');

    expect(doc.getText('source').toString()).toBe(kase.here);
    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(ctx.moved).toEqual([
      { docName: kase.docName, side: 'theirs', bytes: kase.outside, fileType: kase.fileType },
    ]);
    expect(ctx.notices).toEqual([
      {
        docName: kase.docName,
        side: 'theirs',
        fileType: kase.fileType,
        copy: { where: 'history', entry: 'entry-1' },
      },
    ]);
    expect(backupsFor(kase.docName)).toEqual([]);
    expect(ctx.lkgCache.get(kase.docName)).toBe(kase.here);
    expect(ctx.receipts.get(kase.docName)?.hash).toBe(contentHash(kase.here));
    expect(getMetrics().enginelessStore).toEqual({ 'kept-live': 1 });
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(doc.getText('source').toString()).toBe(kase.saved);
  });

  test('when history cannot take the outside version it goes to the backup folder and the edits are written', async () => {
    const ctx = makeCtx({ historySaves: false });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('kept-live');

    expect(doc.getText('source').toString()).toBe(kase.here);
    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(backupsFor(kase.docName)).toEqual([kase.outside]);
    expect(ctx.notices).toHaveLength(1);
    const [notice] = ctx.notices;
    expect(notice?.copy.where).toBe('backup');
    expect(notice?.copy.where === 'backup' && notice.copy.backup.display).toMatch(
      /^~\/\.ok\/edit-backups\/discarded\/projects\/[0-9a-f]{8}\/.+/,
    );
    expect(getMetrics().displacedVersionBackups).toBe(1);
  });

  test('writes nothing and keeps the version here live when neither history nor the backup folder can take the outside version', async () => {
    blockBackups();
    const ctx = makeCtx({ historySaves: false });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toEqual({
      kind: 'held',
      cause: 'no-history-or-backup',
    });

    expect(doc.getText('source').toString()).toBe(kase.here);
    expect(readDocFile(kase.docName)).toBe(kase.outside);
    expect(ctx.lkgCache.get(kase.docName)).toBe(kase.saved);
    expect(ctx.notices).toEqual([]);
    expect(getMetrics().enginelessStore).toEqual({ 'held-no-history-or-backup': 1 });
    expect(getMetrics().displacedVersionBackupFailures).toBe(1);
  });
});

describe('the compare read before an engine-less write', () => {
  test('a persistence with no history recorder keeps the outside version in the backup folder before writing', async () => {
    const kase = ENGINELESS_CASES[0];
    const ctx = makeCtx({ noHistory: true });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('kept-live');
    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(backupsFor(kase.docName)).toEqual([kase.outside]);
  });

  test('a persistence with no history recorder and no backup folder never writes over an outside change', async () => {
    blockBackups();
    const kase = ENGINELESS_CASES[0];
    const ctx = makeCtx({ noHistory: true });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toEqual({
      kind: 'held',
      cause: 'no-history-or-backup',
    });
    expect(readDocFile(kase.docName)).toBe(kase.outside);
  });

  test('retries a busy read, then writes nothing when the file stays unreadable', async () => {
    const kase = ENGINELESS_CASES[0];
    const ctx = makeCtx();
    const { doc } = openWithUnsavedEdit(kase, ctx);
    vi.spyOn(fsTraced, 'tracedReadObservedSync').mockImplementation(() => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toEqual({
      kind: 'held',
      cause: 'unreadable',
    });

    vi.restoreAllMocks();
    expect(readDocFile(kase.docName)).toBe(kase.saved);
    expect(getMetrics().enginelessStore).toEqual({ 'held-unreadable': 1 });
    expect(getMetrics().storeDiskCompareReadRetries).toBe(3);
  });
});

describe('an outside write that lands while an engine-less save runs', () => {
  test('a write during the history save is also moved to history before the edits are written', async () => {
    const kase = ENGINELESS_CASES[0];
    const later = 'graph TD\n  A-->E\n';
    let planted = false;
    const ctx = makeCtx({
      duringSave: () => {
        if (planted) return;
        planted = true;
        writeDocFile(kase.docName, later);
      },
    });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('kept-live');

    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(ctx.moved.map((version) => version.bytes)).toEqual([kase.outside, later]);
  });

  test('a write between the compare and the rename is refused, moved to history, and the edits land after it', async () => {
    const kase = ENGINELESS_CASES[2];
    const ctx = makeCtx();
    const { doc } = openWithUnsavedEdit(kase, ctx);
    const between = 'export const value = 44;\n';
    const write = tracedAtomicFs.writeFile;
    let planted = false;
    vi.spyOn(tracedAtomicFs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (planted) return;
      planted = true;
      writeDocFile(kase.docName, between);
    });

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('kept-live');

    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(ctx.moved.map((version) => version.bytes)).toEqual([between]);
    expect(getMetrics().storeRestatRefused).toBe(1);
  });

  test('gives up after three outside versions in a row, each in history, and writes nothing', async () => {
    const kase = ENGINELESS_CASES[0];
    let next = 0;
    const ctx = makeCtx({
      duringSave: () => {
        next += 1;
        writeDocFile(kase.docName, `graph TD\n  A-->V${next}\n`);
      },
    });
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toEqual({
      kind: 'held',
      cause: 'keeps-changing',
    });

    expect(ctx.moved).toHaveLength(3);
    expect(readDocFile(kase.docName)).not.toBe(kase.here);
    expect(getMetrics().enginelessStore).toEqual({ 'held-exhausted': 1 });
  });

  test('an outside version that is not valid UTF-8 is never written over, at the save or the intake', async () => {
    const kase = ENGINELESS_CASES[2];
    const ctx = makeCtx();
    const { doc } = openWithUnsavedEdit(kase, ctx);
    const utf16 = Buffer.from('\ufeffexport const value = 5;\r\n', 'utf16le');
    writeFileSync(resolve(contentDir, kase.docName), utf16);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toMatchObject({
      kind: 'held',
      cause: 'not-utf8',
      path: resolve(contentDir, kase.docName),
    });
    expect(await applyExternalEnginelessChange(doc, kase.docName, ctx)).toBe('held');

    expect(readFileSync(resolve(contentDir, kase.docName)).equals(utf16)).toBe(true);
    expect(doc.getText('source').toString()).toBe(kase.here);
    expect(ctx.moved).toEqual([]);
    expect(backupsFor(kase.docName)).toEqual([]);
    expect(getMetrics().enginelessStore).toEqual({ 'held-not-utf8': 1 });
    expect(getMetrics().enginelessIntake).toEqual({ 'held-not-utf8': 1 });
  });
});

describe('applyExternalEnginelessChange', () => {
  test('applies the disk version live when nothing is unsaved', async () => {
    const kase = ENGINELESS_CASES[0];
    const ctx = makeCtx();
    writeDocFile(kase.docName, kase.saved);
    const doc = new Y.Doc();
    loadMermaidDoc(doc, kase.docName, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await applyExternalEnginelessChange(doc, kase.docName, ctx)).toBe('applied');

    expect(doc.getText('source').toString()).toBe(kase.outside);
    expect(ctx.lkgCache.get(kase.docName)).toBe(kase.outside);
    expect(ctx.receipts.get(kase.docName)).toMatchObject({
      hash: contentHash(kase.outside),
      via: 'agreed',
    });
    expect(ctx.moved).toEqual([]);
  });

  test('keeps unsaved edits live, moves the outside version to history once, and the next store writes the edits', async () => {
    const kase = ENGINELESS_CASES[1];
    const ctx = makeCtx();
    const { doc } = openWithUnsavedEdit(kase, ctx);
    writeDocFile(kase.docName, kase.outside);

    expect(await applyExternalEnginelessChange(doc, kase.docName, ctx)).toBe('kept-live');
    expect(doc.getText('source').toString()).toBe(kase.here);
    expect(readDocFile(kase.docName)).toBe(kase.outside);

    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('persisted');
    expect(readDocFile(kase.docName)).toBe(kase.here);
    expect(ctx.moved).toEqual([
      { docName: kase.docName, side: 'theirs', bytes: kase.outside, fileType: kase.fileType },
    ]);
  });

  test('takes nothing in when the file holds its own last write', async () => {
    const kase = ENGINELESS_CASES[2];
    const ctx = makeCtx();
    const doc = new Y.Doc();
    editTo(doc, kase.here);
    expect(await storeMermaidDoc(doc, kase.docName, 'person', ctx)).toBe('persisted');
    editTo(doc, `${kase.here}// more\n`);

    expect(await applyExternalEnginelessChange(doc, kase.docName, ctx)).toBe('unchanged');
    expect(doc.getText('source').toString()).toBe(`${kase.here}// more\n`);
    expect(ctx.moved).toEqual([]);
  });
});

describe('loadMermaidDoc', () => {
  test('seeds Y.Text("source") from disk and mints a lineage epoch', () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe(SRC);
    expect(typeof doc.getMap('lifecycle').get(LINEAGE_EPOCH_KEY)).toBe('string');
    expect(doc.getXmlFragment('default').length).toBe(0);
  });

  test('records an agreed receipt for the bytes it read', () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    loadMermaidDoc(new Y.Doc(), DOC, ctx);
    expect(ctx.receipts.get(DOC)).toMatchObject({ hash: contentHash(SRC), via: 'agreed' });
  });

  test('lazy: a missing file seeds nothing (admitting a doc never creates disk)', () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe('');
  });

  test('idempotent: does not re-seed when Y.Text is already populated', () => {
    writeMmd(SRC);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, 'pre-existing'), 'agent');
    loadMermaidDoc(doc, DOC, ctx);
    expect(doc.getText('source').toString()).toBe('pre-existing');
  });

  test('round-trips store → load through disk unchanged', async () => {
    const ctx = makeCtx();
    const writeDoc = new Y.Doc();
    writeDoc.transact(() => writeDoc.getText('source').insert(0, SRC), 'agent');
    await storeMermaidDoc(writeDoc, DOC, 'agent', ctx);

    const readDoc = new Y.Doc();
    loadMermaidDoc(readDoc, DOC, makeCtx());
    expect(readDoc.getText('source').toString()).toBe(SRC);
  });
});

describe('editable text docs on the verbatim path', () => {
  const TS_DOC = 'src/util.ts';
  const TS_SRC = `export function greet(name: string): string {\n\n  return \`hello $\{name}\`;\n}\n`;

  test('loads a .ts file verbatim into Y.Text("source")', () => {
    mkdirSync(dirname(resolve(contentDir, TS_DOC)), { recursive: true });
    writeFileSync(resolve(contentDir, TS_DOC), TS_SRC, 'utf-8');
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadMermaidDoc(doc, TS_DOC, ctx);
    expect(doc.getText('source').toString()).toBe(TS_SRC);
  });

  test('stores edited .ts bytes back verbatim (no markdown canonicalization)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, TS_SRC), 'agent');
    expect(await storeMermaidDoc(doc, TS_DOC, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(resolve(contentDir, TS_DOC), 'utf-8')).toBe(TS_SRC);
  });
});
