import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { ConflictAuthority } from './conflict-authority.ts';
import { DISPLACED_VERSION_TTL_MS, DocumentDurabilityState } from './document-durability-state.ts';
import {
  reconcileDiskBeforeAgentWrite,
  refuseStaleExternalWrite,
  serializeYDocSource,
} from './external-change.ts';
import { getMetrics } from './metrics.ts';
import { createPersistenceExtension } from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

const STALE_CONTENT = 'alpha\n\nbeta\n';
const ACKNOWLEDGED_CONTENT = 'alpha\n\nbeta gamma\n';

function replaceDocParagraphs(document: Y.Doc, texts: string[]): void {
  const fragment = document.getXmlFragment('default');
  const ytext = document.getText('source');
  if (fragment.length > 0) fragment.delete(0, fragment.length);
  fragment.insert(
    0,
    texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      return paragraph;
    }),
  );
  if (ytext.length > 0) ytext.delete(0, ytext.length);
  ytext.insert(0, `${texts.join('\n\n')}\n`);
}

function fakeHocuspocusWith(docName: string, document: Y.Doc): Hocuspocus {
  return { documents: new Map([[docName, document]]) } as unknown as Hocuspocus;
}

describe('reconcileDiskBeforeAgentWrite — stale external write gate', () => {
  let tmpDir: string;
  let docName: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;

  async function settleWrite(agentTriggered = true): Promise<void> {
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);
    document.transact(
      () => replaceDocParagraphs(document, ['alpha', 'beta gamma']),
      BROWSER_ORIGIN,
    );
    if (agentTriggered) durabilityState.markAgentWriteStore(docName);
    await persistence.extension.onStoreDocument?.({
      document,
      documentName: docName,
      lastTransactionOrigin: BROWSER_ORIGIN,
      lastContext: {},
    } as never);
    expect(durabilityState.getReconciledBase(docName)).toBe(ACKNOWLEDGED_CONTENT);
  }

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-stale-gate-')));
    docName = 'gated-doc';
    document = new Y.Doc();
    durabilityState = new DocumentDurabilityState();
  });

  afterEach(() => {
    document.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('refuses disk bytes the server itself displaced and conflicts the document', async () => {
    await settleWrite();
    const before = getMetrics();
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');

    const result = reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );

    expect(result.reconciled).toBe(false);
    expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
    expect(document.getText('source').toString()).toBe(ACKNOWLEDGED_CONTENT);
    expect(durabilityState.getReconciledBase(docName)).toBe(ACKNOWLEDGED_CONTENT);
    refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT);
    const after = getMetrics();
    expect(after.staleExternalWriteRefused).toBe(before.staleExternalWriteRefused + 1);
    expect(after.conflictCount).toBe(before.conflictCount);
    expect(after.persistenceDivergenceRealign).toBe(before.persistenceDivergenceRealign);
    expect(after.bridgeMergeContentLoss).toBe(before.bridgeMergeContentLoss);
  });

  test('captures live document bytes before stale-write hydration raises the conflict', () => {
    const liveContent = `${ACKNOWLEDGED_CONTENT}\nnext live edit\n`;
    let authority: ConflictAuthority;
    durabilityState = new DocumentDurabilityState('main', {
      onStaleExternalWriteChange: () => {
        for (const stale of durabilityState.listStaleExternalWrites()) {
          const base = durabilityState.getReconciledBase(stale.docName) ?? stale.diskContent;
          authority.raise({
            kind: 'reconcile',
            file: stale.file,
            reason: 'stale-external-write',
            detectedAt: stale.detectedAt,
            stages: {
              base,
              ours: stale.retainedContent ?? base,
              theirs: stale.diskContent,
            },
          });
        }
      },
    });
    authority = new ConflictAuthority({
      projectDir: tmpDir,
      contentDir: tmpDir,
      io: {
        gitRaw: async () => '',
        writeProjectFileUntracked: () => undefined,
        unlinkProjectFile: () => undefined,
        applyResolvedContent: async () => undefined,
      },
    });
    durabilityState.setReconciledBase(docName, ACKNOWLEDGED_CONTENT);
    durabilityState.recordDisplacedVersion(docName, STALE_CONTENT);
    replaceDocParagraphs(document, ['alpha', 'beta gamma', 'next live edit']);

    expect(
      refuseStaleExternalWrite(
        durabilityState,
        document,
        docName,
        STALE_CONTENT,
        authority,
        serializeYDocSource(document),
      ),
    ).toBe(true);

    const conflict = authority.findByDocName(docName);
    expect(conflict?.kind).toBe('reconcile');
    if (conflict?.kind !== 'reconcile') throw new Error('expected a reconcile conflict');
    expect(conflict.stages.ours).toBe(liveContent);
  });

  test('refuses to load rejected bytes when the acknowledged base is missing', async () => {
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');
    durabilityState.recordDisplacedVersion(docName, STALE_CONTENT);
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    await expect(
      persistence.extension.onLoadDocument?.({
        document,
        documentName: docName,
        context: {},
      } as never),
    ).rejects.toThrow('Missing acknowledged content');
    expect(document.getText('source').toString()).toBe('');
  });

  test('lets an external edit that matches no displaced version reconcile normally', async () => {
    await settleWrite();
    writeFileSync(join(tmpDir, `${docName}.md`), 'alpha\n\nbeta gamma\n\ndelta\n', 'utf-8');

    const result = reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );

    expect(result.reconciled).toBe(true);
    expect(document.getMap('lifecycle').get('status')).toBeUndefined();
    expect(document.getText('source').toString()).toContain('delta');
  });

  test('does not classify bytes displaced by a non-agent save as a stale agent rollback', async () => {
    await settleWrite(false);
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');

    const result = reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );

    expect(result.reconciled).toBe(true);
    expect(document.getMap('lifecycle').get('status')).toBeUndefined();
    expect(document.getText('source').toString()).toBe(STALE_CONTENT);
  });

  test('keeps refusing a detected stale write after its history entry expires', async () => {
    vi.useFakeTimers();
    try {
      await settleWrite();
      expect(refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT)).toBe(
        true,
      );

      vi.advanceTimersByTime(DISPLACED_VERSION_TTL_MS + 1_000);

      expect(refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT)).toBe(
        true,
      );
      expect(document.getText('source').toString()).toBe(ACKNOWLEDGED_CONTENT);
    } finally {
      vi.useRealTimers();
    }
  });

  test('clears a stale conflict when disk catches up to the acknowledged version', async () => {
    await settleWrite();
    expect(refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT)).toBe(true);

    expect(refuseStaleExternalWrite(durabilityState, document, docName, ACKNOWLEDGED_CONTENT)).toBe(
      false,
    );
    expect(document.getMap('lifecycle').get('status')).toBeUndefined();
    expect(durabilityState.listStaleExternalWrites()).toEqual([]);
  });

  test('pre-write reconciliation can clear a stale conflict after disk catches up', async () => {
    await settleWrite();
    expect(refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT)).toBe(true);
    writeFileSync(join(tmpDir, `${docName}.md`), ACKNOWLEDGED_CONTENT, 'utf-8');

    reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );

    expect(document.getMap('lifecycle').get('status')).toBeUndefined();
    expect(durabilityState.listStaleExternalWrites()).toEqual([]);
  });

  test('lets a genuinely new external edit replace a stale conflict', async () => {
    await settleWrite();
    expect(refuseStaleExternalWrite(durabilityState, document, docName, STALE_CONTENT)).toBe(true);

    const externalEdit = `${ACKNOWLEDGED_CONTENT}\ndelta\n`;
    expect(refuseStaleExternalWrite(durabilityState, document, docName, externalEdit)).toBe(false);
    expect(document.getMap('lifecycle').get('status')).toBeUndefined();
    expect(durabilityState.listStaleExternalWrites()).toEqual([]);
  });

  test('restores the acknowledged base instead of stale disk bytes when a document reloads', async () => {
    await settleWrite();
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');
    expect(refuseStaleExternalWrite(durabilityState, undefined, docName, STALE_CONTENT)).toBe(true);

    document.destroy();
    document = new Y.Doc();
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);

    expect(document.getText('source').toString()).toBe(ACKNOWLEDGED_CONTENT);
    expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
    expect(durabilityState.getReconciledBase(docName)).toBe(ACKNOWLEDGED_CONTENT);
  });

  test('restores the acknowledged base instead of stale disk bytes after a server restart', async () => {
    const persistencePath = join(tmpDir, 'stale-external-writes.json');
    durabilityState = new DocumentDurabilityState('main', { persistencePath });
    await settleWrite();
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');

    document.destroy();
    document = new Y.Doc();
    durabilityState = new DocumentDurabilityState('main', { persistencePath });
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });
    await persistence.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);

    expect(document.getText('source').toString()).toBe(ACKNOWLEDGED_CONTENT);
    expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
  });

  test('the final persistence disk read refuses a stale version that arrives after preflight', async () => {
    const persistencePath = join(tmpDir, 'state.json');
    durabilityState = new DocumentDurabilityState('main', { persistencePath });
    durabilityState.setReconciledBase(docName, ACKNOWLEDGED_CONTENT);
    durabilityState.recordDisplacedVersion(docName, STALE_CONTENT);
    replaceDocParagraphs(document, ['alpha', 'beta gamma', 'next agent edit']);
    writeFileSync(join(tmpDir, `${docName}.md`), STALE_CONTENT, 'utf-8');
    durabilityState.markAgentWriteStore(docName);
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });

    await persistence.extension.onStoreDocument?.({
      document,
      documentName: docName,
      lastTransactionOrigin: BROWSER_ORIGIN,
      lastContext: {},
    } as never);

    expect(document.getText('source').toString()).toContain('next agent edit');
    expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
    expect(durabilityState.getReconciledBase(docName)).toBe(ACKNOWLEDGED_CONTENT);
    expect(durabilityState.takeStaleExternalWriteFreeze(docName)).toBe(true);
    expect(durabilityState.takeStoreDivergence(docName)).toBe(false);
    const retained = document.getText('source').toString();
    durabilityState.recordDisplacedVersion(docName, 'an older displaced version\n');
    writeFileSync(join(tmpDir, `${docName}.md`), 'an older displaced version\n', 'utf-8');
    expect(
      refuseStaleExternalWrite(durabilityState, document, docName, 'an older displaced version\n'),
    ).toBe(true);
    document.destroy();
    document = new Y.Doc();
    const restoredState = new DocumentDurabilityState('main', { persistencePath });
    const restarted = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState: restoredState,
    });
    await restarted.extension.onLoadDocument?.({
      document,
      documentName: docName,
      context: {},
    } as never);
    expect(document.getText('source').toString()).toBe(retained);
    expect(restoredState.getReconciledBase(docName)).toBe(ACKNOWLEDGED_CONTENT);
    expect(restoredState.getStaleExternalWrite(docName)).toBeDefined();
  });

  test('normalized-equal displaced bytes remain a conflict until exact acknowledged bytes return', async () => {
    const crlfStale = ACKNOWLEDGED_CONTENT.replaceAll('\n', '\r\n');
    durabilityState.setReconciledBase(docName, ACKNOWLEDGED_CONTENT);
    durabilityState.recordDisplacedVersion(docName, crlfStale);
    replaceDocParagraphs(document, ['alpha', 'beta gamma']);
    writeFileSync(join(tmpDir, `${docName}.md`), crlfStale, 'utf-8');
    reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );
    expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
    expect(document.getText('source').toString()).toBe(ACKNOWLEDGED_CONTENT);
    writeFileSync(join(tmpDir, `${docName}.md`), ACKNOWLEDGED_CONTENT, 'utf-8');
    reconcileDiskBeforeAgentWrite(
      durabilityState,
      fakeHocuspocusWith(docName, document),
      docName,
      tmpDir,
    );
    expect(durabilityState.getStaleExternalWrite(docName)).toBeUndefined();
  });

  test.each([ACKNOWLEDGED_CONTENT, 'genuinely new external content\n'])(
    'a pending retained edit survives disk replacement with %s before restart',
    async (diskContent) => {
      const persistencePath = join(tmpDir, 'state.json');
      durabilityState = new DocumentDurabilityState('main', { persistencePath });
      const retained = `${ACKNOWLEDGED_CONTENT}\nnext retained edit\n`;
      durabilityState.setReconciledBase(docName, ACKNOWLEDGED_CONTENT);
      durabilityState.recordDisplacedVersion(docName, STALE_CONTENT);
      durabilityState.recordStaleExternalWrite(docName, STALE_CONTENT, retained);
      const beforeReplacement = getMetrics();
      replaceDocParagraphs(document, ['alpha', 'beta gamma', 'next retained edit']);
      writeFileSync(join(tmpDir, `${docName}.md`), diskContent, 'utf-8');
      reconcileDiskBeforeAgentWrite(
        durabilityState,
        fakeHocuspocusWith(docName, document),
        docName,
        tmpDir,
      );
      expect(durabilityState.getStaleExternalWrite(docName)).toBeDefined();
      expect(refuseStaleExternalWrite(durabilityState, undefined, docName, diskContent)).toBe(true);
      expect(getMetrics().staleExternalWriteRefused).toBe(
        beforeReplacement.staleExternalWriteRefused + 1,
      );
      expect(getMetrics().conflictCount).toBe(beforeReplacement.conflictCount);
      document.destroy();
      document = new Y.Doc();
      const restored = new DocumentDurabilityState('main', { persistencePath });
      const persistence = createPersistenceExtension({
        contentDir: tmpDir,
        projectDir: tmpDir,
        gitEnabled: false,
        durabilityState: restored,
      });
      await persistence.extension.onLoadDocument?.({
        document,
        documentName: docName,
        context: {},
      } as never);
      expect(document.getText('source').toString()).toBe(retained);
      expect(restored.getStaleExternalWrite(docName)).toBeDefined();
      expect(restored.getStaleExternalWrite(docName)?.diskContent).toBe(diskContent);
      expect(getMetrics().staleExternalWriteRefused).toBe(
        beforeReplacement.staleExternalWriteRefused + 1,
      );
    },
  );

  test('records the exact disk spelling displaced by an agent write', async () => {
    const crlfStale = STALE_CONTENT.replaceAll('\n', '\r\n');
    writeFileSync(join(tmpDir, `${docName}.md`), crlfStale, 'utf-8');
    durabilityState.setReconciledBase(docName, STALE_CONTENT);
    replaceDocParagraphs(document, ['alpha', 'beta gamma']);
    durabilityState.markAgentWriteStore(docName);
    const persistence = createPersistenceExtension({
      contentDir: tmpDir,
      projectDir: tmpDir,
      gitEnabled: false,
      durabilityState,
    });

    await persistence.extension.onStoreDocument?.({
      document,
      documentName: docName,
      lastTransactionOrigin: BROWSER_ORIGIN,
      lastContext: {},
    } as never);

    expect(durabilityState.isDisplacedVersion(docName, crlfStale)).toBe(true);
  });
});
