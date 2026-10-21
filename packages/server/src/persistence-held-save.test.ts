import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DOC_NAME_PROJECT, type ConfigValidationError } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import * as fsTraced from './fs-traced.ts';
import type { MergeHistoryRecorder } from './merge-history.ts';
import { createPersistenceExtension } from './persistence.ts';
import type { VisibleHoldCause } from './save-hold.ts';

interface Rig {
  persistence: ReturnType<typeof createPersistenceExtension>;
  held: Array<{ docName: string; cause: VisibleHoldCause }>;
  cleared: string[];
  rejections: Array<{ docName: string; error: ConfigValidationError }>;
}

let root: string;
let contentDir: string;
let home: string;

function makeRig(): Rig {
  const held: Rig['held'] = [];
  const cleared: string[] = [];
  const rejections: Rig['rejections'] = [];
  const mergeHistory: MergeHistoryRecorder = {
    bothKept: () => {},
    keptLive: async () => false,
    saveNoEngine: async () => null,
    noticeNoEngine: () => {},
    noticeBackup: () => {},
    noticeHeld: (docName, cause) => {
      held.push({ docName, cause });
    },
    clearHeld: (docName) => {
      cleared.push(docName);
    },
  };
  const persistence = createPersistenceExtension({
    mergeHistory,
    ingestDiskAtStore: null,
    contentDir,
    projectDir: contentDir,
    configHomedirOverride: home,
    onConfigRejected: (docName, error) => {
      rejections.push({ docName, error });
    },
  });
  return { persistence, held, cleared, rejections };
}

async function open(rig: Rig, documentName: string): Promise<Y.Doc> {
  const document = new Y.Doc();
  await rig.persistence.extension.onLoadDocument?.({
    document,
    documentName,
    context: {},
  } as never);
  return document;
}

function edit(document: Y.Doc, text: string): void {
  document.transact(() => {
    const source = document.getText('source');
    source.delete(0, source.length);
    source.insert(0, text);
  }, 'person');
}

async function store(rig: Rig, document: Y.Doc, documentName: string): Promise<void> {
  await rig.persistence.extension.onStoreDocument?.({
    document,
    documentName,
    lastTransactionOrigin: 'person',
    lastContext: {},
  } as never);
}

function blockBackups(): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'edit-backups'), 'not a folder');
}

function unblockBackups(): void {
  rmSync(join(home, '.ok', 'edit-backups'), { force: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-held-save-'));
  contentDir = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('a held save of a file with no merge engine', () => {
  test('raises its notice at every hold, stays due at every sweep, and withdraws the notice once the save lands', async () => {
    const rig = makeRig();
    writeFileSync(join(contentDir, 'flow.mmd'), 'graph TD\n  A-->B\n');
    const document = await open(rig, 'flow.mmd');
    edit(document, 'graph TD\n  A-->C\n');
    writeFileSync(join(contentDir, 'flow.mmd'), 'graph TD\n  A-->D\n');
    blockBackups();

    await store(rig, document, 'flow.mmd');
    await rig.persistence.retryHeldSave(document, 'flow.mmd');

    expect(rig.held).toEqual([
      { docName: 'flow.mmd', cause: 'no-history-or-backup' },
      { docName: 'flow.mmd', cause: 'no-history-or-backup' },
    ]);
    expect(rig.persistence.isHeldSaveDue('flow.mmd')).toBe(true);
    expect(rig.persistence.hasHeldSave('flow.mmd')).toBe(true);
    expect(rig.cleared).toEqual([]);

    unblockBackups();
    await rig.persistence.retryHeldSave(document, 'flow.mmd');

    expect(rig.cleared).toEqual(['flow.mmd']);
    expect(rig.persistence.isHeldSaveDue('flow.mmd')).toBe(false);
    expect(rig.persistence.hasHeldSave('flow.mmd')).toBe(false);
  });

  test('a file that cannot be read raises a notice with that cause', async () => {
    const rig = makeRig();
    writeFileSync(join(contentDir, 'flow.mmd'), 'graph TD\n  A-->B\n');
    const document = await open(rig, 'flow.mmd');
    edit(document, 'graph TD\n  A-->C\n');
    vi.spyOn(fsTraced, 'tracedReadObservedSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    await store(rig, document, 'flow.mmd');

    expect(rig.held).toEqual([{ docName: 'flow.mmd', cause: 'unreadable' }]);
    expect(rig.persistence.isHeldSaveDue('flow.mmd')).toBe(true);
  });

  test('a file that is not UTF-8 is not due again until it changes', async () => {
    const rig = makeRig();
    const path = join(contentDir, 'util.ts');
    writeFileSync(path, 'export const value = 1;\n');
    const document = await open(rig, 'util.ts');
    edit(document, 'export const value = 2;\n');
    writeFileSync(path, Buffer.from('﻿export const value = 3;\r\n', 'utf16le'));

    await store(rig, document, 'util.ts');

    expect(rig.held).toEqual([{ docName: 'util.ts', cause: 'not-utf8' }]);
    expect(rig.persistence.isHeldSaveDue('util.ts')).toBe(false);

    writeFileSync(path, 'export const value = 4;\n');

    expect(rig.persistence.isHeldSaveDue('util.ts')).toBe(true);
  });
});

describe('a held settings save', () => {
  test('goes through the rejection channel with its cause and the file it names, not a notice', async () => {
    const rig = makeRig();
    const path = join(contentDir, '.ok', 'config.yml');
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: true\n');
    const document = await open(rig, CONFIG_DOC_NAME_PROJECT);
    edit(document, 'mcp:\n  autoStart: false\n');
    writeFileSync(path, 'mcp: [unclosed\n');
    blockBackups();

    await store(rig, document, CONFIG_DOC_NAME_PROJECT);
    await rig.persistence.retryHeldSave(document, CONFIG_DOC_NAME_PROJECT);

    expect(rig.rejections).toEqual([
      {
        docName: CONFIG_DOC_NAME_PROJECT,
        error: { code: 'SAVE_HELD', cause: 'no-history-or-backup', file: '.ok/config.yml' },
      },
    ]);
    expect(rig.held).toEqual([]);
  });

  test('is sent again when its cause changes, and only then', async () => {
    const rig = makeRig();
    const path = join(contentDir, '.ok', 'config.yml');
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeFileSync(path, 'mcp:\n  autoStart: true\n');
    const document = await open(rig, CONFIG_DOC_NAME_PROJECT);
    edit(document, 'mcp:\n  autoStart: false\n');
    writeFileSync(path, 'mcp: [unclosed\n');
    blockBackups();
    await store(rig, document, CONFIG_DOC_NAME_PROJECT);

    writeFileSync(path, Buffer.from('mcp:\n  note: caf\u00e9\n', 'latin1'));
    await rig.persistence.retryHeldSave(document, CONFIG_DOC_NAME_PROJECT);
    writeFileSync(path, Buffer.from('mcp:\n  note: na\u00efve\n', 'latin1'));
    await rig.persistence.retryHeldSave(document, CONFIG_DOC_NAME_PROJECT);

    expect(rig.rejections.map(({ error }) => error)).toEqual([
      { code: 'SAVE_HELD', cause: 'no-history-or-backup', file: '.ok/config.yml' },
      { code: 'SAVE_HELD', cause: 'not-utf8', file: '.ok/config.yml' },
    ]);
  });
});
