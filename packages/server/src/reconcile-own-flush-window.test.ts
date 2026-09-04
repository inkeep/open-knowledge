import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { isDocInConflict } from './conflict-errors.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import {
  type ReconcileBeforeWriteResult,
  reconcileDiskBeforeAgentWrite,
} from './external-change.ts';
import { createPersistenceExtension } from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

function replaceDocParagraphs(document: Y.Doc, texts: string[]): void {
  const body = `${texts.join('\n\n')}\n`;
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  if (fragment.length > 0) {
    fragment.delete(0, fragment.length);
  }
  fragment.insert(
    0,
    texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  if (ytext.length > 0) {
    ytext.delete(0, ytext.length);
  }
  ytext.insert(0, body);
}

async function loadDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onLoadDocument?.({
    document,
    documentName,
    context: {},
  } as never);
}

async function storeDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onStoreDocument?.({
    document,
    documentName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  } as never);
}

function fakeHocuspocusWith(docName: string, document: Y.Doc): Hocuspocus {
  return { documents: new Map([[docName, document]]) } as unknown as Hocuspocus;
}

const BASE_CONTENT = 'alpha\n\nbeta\n';
const FLUSHED_PARAGRAPHS = ['alpha', 'beta gamma'];
const FLUSHED_CONTENT = 'alpha\n\nbeta gamma\n';
const LIVE_PARAGRAPHS = ['alpha', 'beta gamma delta'];

interface WindowProbe {
  windowResult: ReconcileBeforeWriteResult | undefined;
  baseSeenInWindow: string | undefined;
  inFlightSeenInWindow: string | undefined;
  conflictAfterGuard: boolean | undefined;
}

async function drivePhantomDivergence(
  tmpDir: string,
  docName: string,
  document: Y.Doc,
  durabilityState: DocumentDurabilityState,
  options: { diskContentInWindow?: string } = {},
): Promise<WindowProbe> {
  const docPath = join(tmpDir, `${docName}.md`);
  writeFileSync(docPath, BASE_CONTENT, 'utf-8');

  const probe: WindowProbe = {
    windowResult: undefined,
    baseSeenInWindow: undefined,
    inFlightSeenInWindow: undefined,
    conflictAfterGuard: undefined,
  };

  let windowFired = false;
  const persistence = createPersistenceExtension({
    contentDir: tmpDir,
    projectDir: tmpDir,
    gitEnabled: false,
    durabilityState,
    onDiskFlush: (name) => {
      if (name !== docName || windowFired) return;
      windowFired = true;
      document.transact(() => replaceDocParagraphs(document, LIVE_PARAGRAPHS), BROWSER_ORIGIN);
      probe.baseSeenInWindow = durabilityState.getReconciledBase(docName);
      probe.inFlightSeenInWindow = durabilityState.peekInFlightFlush(docName);
      if (options.diskContentInWindow !== undefined) {
        writeFileSync(docPath, options.diskContentInWindow, 'utf-8');
      }
      probe.windowResult = reconcileDiskBeforeAgentWrite(
        durabilityState,
        fakeHocuspocusWith(docName, document),
        docName,
        tmpDir,
      );
      probe.conflictAfterGuard = isDocInConflict(document as never);
    },
  });

  await loadDocument(persistence, document, docName);
  document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);
  await storeDocument(persistence, document, docName);

  expect(windowFired).toBe(true);
  expect(probe.baseSeenInWindow).toBe(BASE_CONTENT);
  return probe;
}

describe('reconcileDiskBeforeAgentWrite — own persistence flush is not foreign divergence', () => {
  let tmpDir: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-own-flush-window-')));
    mkdirSync(tmpDir, { recursive: true });
    durabilityState = new DocumentDurabilityState();
    document = new Y.Doc();
  });

  afterEach(() => {
    document.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("an agent write inside the server's own flush-commit window is not refused and does not latch lifecycle conflict", async () => {
    const docName = 'own-flush-window';
    const probe = await drivePhantomDivergence(tmpDir, docName, document, durabilityState);

    expect(probe.conflictAfterGuard).toBe(false);
    expect(isDocInConflict(document as never)).toBe(false);
    expect(probe.windowResult?.reconciled).toBe(false);
    expect(probe.inFlightSeenInWindow).toBe(normalizeBridge(FLUSHED_CONTENT));
  });

  test('a FOREIGN disk edit landing inside the flush window still reconciles (narrow-equality safety boundary)', async () => {
    const docName = 'own-flush-foreign-in-window';
    const FOREIGN_CONTENT = 'alpha FOREIGN EDIT\n\nbeta\n';
    const probe = await drivePhantomDivergence(tmpDir, docName, document, durabilityState, {
      diskContentInWindow: FOREIGN_CONTENT,
    });

    expect(probe.inFlightSeenInWindow).toBe(normalizeBridge(FLUSHED_CONTENT));
    expect(probe.windowResult?.reconciled).toBe(true);
    expect(probe.windowResult?.mergeOutcome).toBe('merged');
  });

  test('no permanent 409 wedge: after the flush settles, subsequent agent writes are not refused', async () => {
    const docName = 'own-flush-wedge';
    await drivePhantomDivergence(tmpDir, docName, document, durabilityState);

    expect(durabilityState.getReconciledBase(docName)).toBe(FLUSHED_CONTENT);

    const laterGuard = reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );
    expect(laterGuard.reconciled).toBe(false);

    expect(isDocInConflict(document as never)).toBe(false);
  });

  test('a failed disk flush does not leave the in-flight flush signal stuck set', async () => {
    const docName = 'own-flush-fault';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, BASE_CONTENT, 'utf-8');

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);

    const prevFault = process.env.OK_TEST_STORE_FAULT;
    process.env.OK_TEST_STORE_FAULT = docName;
    try {
      await expect(storeDocument(persistence, document, docName)).rejects.toThrow(
        'OK_TEST_STORE_FAULT',
      );
    } finally {
      if (prevFault === undefined) {
        delete process.env.OK_TEST_STORE_FAULT;
      } else {
        process.env.OK_TEST_STORE_FAULT = prevFault;
      }
    }

    expect(durabilityState.peekInFlightFlush(docName)).toBeUndefined();
    expect(durabilityState.getReconciledBase(docName)).toBe(BASE_CONTENT);
  });

  test("an earlier overlapping flush settling does not clear a later flush's in-flight signal", async () => {
    const docName = 'own-flush-overlap';
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, BASE_CONTENT, 'utf-8');

    const OVERLAP_PARAGRAPHS = ['alpha', 'beta gamma epsilon'];
    const OVERLAP_CONTENT = 'alpha\n\nbeta gamma epsilon\n';

    let windowFired = false;
    let laterFlush: Promise<void> | undefined;
    let peekAfterLaterStart: string | undefined;
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
      onDiskFlush: (name) => {
        if (name !== docName || windowFired) return;
        windowFired = true;
        document.transact(() => replaceDocParagraphs(document, OVERLAP_PARAGRAPHS), BROWSER_ORIGIN);
        laterFlush = storeDocument(persistence, document, docName);
        peekAfterLaterStart = durabilityState.peekInFlightFlush(docName);
      },
    });

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);
    await storeDocument(persistence, document, docName);

    expect(windowFired).toBe(true);
    expect(peekAfterLaterStart).toBe(normalizeBridge(OVERLAP_CONTENT));
    expect(durabilityState.peekInFlightFlush(docName)).toBe(normalizeBridge(OVERLAP_CONTENT));

    await laterFlush;
    expect(durabilityState.peekInFlightFlush(docName)).toBeUndefined();
  });
});

describe('reconcileDiskBeforeAgentWrite — overlapping own flushes are not foreign divergence', () => {
  let tmpDir: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-own-flush-overlap-')));
    mkdirSync(tmpDir, { recursive: true });
    durabilityState = new DocumentDurabilityState();
    document = new Y.Doc();
  });

  afterEach(() => {
    document.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function driveOverlapWindow(
    docName: string,
    options: { diskContentInWindow?: string } = {},
  ): Promise<{
    diskAtWindow: string;
    pendingAtWindow: number;
    headAtWindow: string | undefined;
    diskMatchedPendingAtWindow: boolean;
    result: ReconcileBeforeWriteResult | undefined;
    conflictAfterGuard: boolean | undefined;
  }> {
    const docPath = join(tmpDir, `${docName}.md`);
    writeFileSync(docPath, BASE_CONTENT, 'utf-8');

    const OVERLAP_PARAGRAPHS = ['alpha', 'beta gamma epsilon'];
    let windowFired = false;
    let laterFlush: Promise<void> | undefined;
    let diskAtWindow = '';
    let pendingAtWindow = 0;
    let headAtWindow: string | undefined;
    let diskMatchedPendingAtWindow = false;
    let result: ReconcileBeforeWriteResult | undefined;
    let conflictAfterGuard: boolean | undefined;

    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
      onDiskFlush: (name) => {
        if (name !== docName || windowFired) return;
        windowFired = true;
        document.transact(() => replaceDocParagraphs(document, OVERLAP_PARAGRAPHS), BROWSER_ORIGIN);
        laterFlush = storeDocument(persistence, document, docName);
        if (options.diskContentInWindow !== undefined) {
          writeFileSync(docPath, options.diskContentInWindow, 'utf-8');
        }
        diskAtWindow = readFileSync(docPath, 'utf-8');
        pendingAtWindow = durabilityState.inFlightFlushCount(docName);
        headAtWindow = durabilityState.peekInFlightFlush(docName);
        diskMatchedPendingAtWindow = durabilityState.hasInFlightFlush(
          docName,
          normalizeBridge(diskAtWindow),
        );
        result = reconcileDiskBeforeAgentWrite(
          durabilityState,
          fakeHocuspocusWith(docName, document),
          docName,
          tmpDir,
        );
        conflictAfterGuard = isDocInConflict(document as never);
      },
    });

    await loadDocument(persistence, document, docName);
    document.transact(() => replaceDocParagraphs(document, FLUSHED_PARAGRAPHS), BROWSER_ORIGIN);
    await storeDocument(persistence, document, docName);
    await laterFlush;

    expect(windowFired).toBe(true);
    expect(pendingAtWindow).toBeGreaterThanOrEqual(2);
    return {
      diskAtWindow,
      pendingAtWindow,
      headAtWindow,
      diskMatchedPendingAtWindow,
      result,
      conflictAfterGuard,
    };
  }

  test('an agent write landing between two overlapping own flushes does not latch lifecycle conflict', async () => {
    const probe = await driveOverlapWindow('overlap-window-clean');

    expect(normalizeBridge(probe.diskAtWindow)).toBe(normalizeBridge(FLUSHED_CONTENT));
    expect(probe.diskMatchedPendingAtWindow).toBe(true);
    expect(probe.headAtWindow).not.toBe(normalizeBridge(probe.diskAtWindow));
    expect(probe.conflictAfterGuard).toBe(false);
    expect(isDocInConflict(document as never)).toBe(false);
    expect(document.getMap('lifecycle').get('reason')).toBeUndefined();
    expect(probe.result?.reconciled).toBe(false);
  });

  test('a FOREIGN disk edit landing in the overlap window still reconciles', async () => {
    const probe = await driveOverlapWindow('overlap-window-foreign', {
      diskContentInWindow: 'alpha FOREIGN EDIT\n\nbeta\n',
    });

    expect(probe.diskMatchedPendingAtWindow).toBe(false);
    expect(probe.result?.reconciled).toBe(true);
    expect(probe.result?.mergeOutcome).toBe('merged');
    expect(probe.conflictAfterGuard).toBe(false);
    expect(isDocInConflict(document as never)).toBe(false);
  });
});
