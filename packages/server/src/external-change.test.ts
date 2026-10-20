import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import {
  applyExternalChange,
  buildReconcileWarning,
  createExternalChangeHandler,
  reconcileDiskBeforeAgentWrite,
  reportReconcileBothKept,
  reportReconcileCheckFailed,
} from './external-change.ts';
import { getLogger } from './logger.ts';
import type { MergeHistoryRecorder } from './merge-history.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { reconcile } from './reconciliation.ts';

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn): Y.Doc {
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

const SECRET_YTEXT = 'PRIVATE-NOTE-ytext-body';
const SECRET_FRAGMENT = 'PRIVATE-NOTE-fragment-body';
const SECRET_DIFF = 'PRIVATE-NOTE-unified-diff-body';

function loggedReconcileErrorPayload(spy: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  const call = spy.mock.calls.find(
    (args) => typeof args[1] === 'string' && args[1].includes('reconciled base'),
  );
  if (!call) throw new Error('reconcile recovery failure was not logged');
  return call[0] as Record<string, unknown>;
}

describe('applyExternalChange — throwing helper', () => {
  let hp: Hocuspocus;
  let durabilityState: DocumentDurabilityState;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
    durabilityState = new DocumentDurabilityState();
  });

  test('(a) document-missing early return — no throw, no mutations', () => {
    expect(() => {
      applyExternalChange(durabilityState, hp, 'nonexistent-doc', '# Hello\n\nWorld\n');
    }).not.toThrow();
    expect(hp.documents.get('nonexistent-doc')).toBeUndefined();
  });

  test('(b) frontmatter asymmetry — XmlFragment gets body only, Y.Text gets full content (D8)', async () => {
    const docName = 'test-frontmatter-asymmetry';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const fullContent = '---\ntitle: Test\ntags: [a, b]\n---\n# Hello\n\nParagraph text.\n';

    applyExternalChange(durabilityState, hp, docName, fullContent);

    const ytext = doc.getText('source');
    expect(ytext.toString()).toBe(fullContent);

    const { frontmatter } = stripFrontmatter(ytext.toString());
    expect(frontmatter).toContain('title: Test');
    expect(frontmatter).toContain('---');

    const xmlFragment = doc.getXmlFragment('default');
    const xmlString = xmlFragment.toString();
    expect(xmlString).not.toContain('title: Test');
    expect(xmlString).not.toContain('tags: [a, b]');

    await conn.disconnect();
  });

  test('(b2) repeated apply with identical content does not mutate Y.Text', async () => {
    const docName = 'test-ytext-stable';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const content = '---\ntitle: Stable\nstatus: draft\n---\n# Body\n';
    applyExternalChange(durabilityState, hp, docName, content);

    let textMutations = 0;
    const ytext = doc.getText('source');
    const observer = () => {
      textMutations++;
    };
    ytext.observe(observer);

    applyExternalChange(durabilityState, hp, docName, content);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);

    await conn.disconnect();
  });

  test('(b3) malformed YAML round-trips into Y.Text verbatim (D31 — Y.Text is the source of truth)', async () => {
    const docName = 'test-malformed-yaml';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const malformed = '---\ntitle: [unterminated\nstatus: published\n---\n# Body\n';
    applyExternalChange(durabilityState, hp, docName, malformed);

    expect(doc.getText('source').toString()).toBe(malformed);

    await conn.disconnect();
  });

  test('(b4) FM-indent preserved verbatim; body canonicalized to match XmlFragment (bridge invariant)', async () => {
    const docName = 'test-fm-indent-body-canonical';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const onDisk = '---\ntags:\n  - characters\n  - air-nomads\n---\n\n# Aang\n';
    applyExternalChange(durabilityState, hp, docName, onDisk);

    const ytext = doc.getText('source').toString();
    const { frontmatter } = stripFrontmatter(ytext);
    expect(frontmatter).toBe('---\ntags:\n  - characters\n  - air-nomads\n---\n');

    await conn.disconnect();
  });

  test('(b5) Y.Text-is-truth: doc-start `---` survives in Y.Text (no canonicalize-write-back)', async () => {
    const docName = 'test-thematic-break-raw';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, docName, '---\n');

    const ytext = doc.getText('source').toString();
    expect(ytext).toBe('---\n');

    await conn.disconnect();
  });

  test('(c) Y.Text no-op — delete/insert skipped when content unchanged', async () => {
    const docName = 'test-ytext-noop';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const content = '# Hello\n\nWorld\n';

    applyExternalChange(durabilityState, hp, docName, content);
    expect(doc.getText('source').toString()).toBe(content);

    let textMutations = 0;
    const ytext = doc.getText('source');
    const observer = () => {
      textMutations++;
    };
    ytext.observe(observer);

    applyExternalChange(durabilityState, hp, docName, content);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);

    await conn.disconnect();
  });

  test('(d) transaction origin matches paired-write shape', async () => {
    const docName = 'test-tx-origin';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    let capturedOrigin: unknown = null;
    doc.on('beforeTransaction', (tx: Y.Transaction) => {
      if (
        tx.origin &&
        typeof tx.origin === 'object' &&
        'context' in tx.origin &&
        (tx.origin as { context?: { origin?: string } }).context?.origin === 'file-watcher'
      ) {
        capturedOrigin = tx.origin;
      }
    });

    applyExternalChange(durabilityState, hp, docName, '# Test\n');

    expect(capturedOrigin).toEqual({
      source: 'local',
      skipStoreHooks: true,
      context: { origin: 'file-watcher', paired: true },
    });

    await conn.disconnect();
  });

  test('(e) catch path on post-mutation transact throw sets reconciledBase to mutated ytext', async () => {
    const docName = 'test-catch-bounds-post-mutation';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    applyExternalChange(durabilityState, hp, docName, '# Original\n');
    durabilityState.setReconciledBase(docName, '# Original\n');
    expect(doc.getText('source').toString()).toBe('# Original\n');
    expect(durabilityState.getReconciledBase(docName)).toBe('# Original\n');

    const originalTransact = doc.transact.bind(doc);
    doc.transact = ((fn: () => void, origin: unknown) => {
      originalTransact(() => {
        fn();
        throw new Error('synthetic post-mutation transact failure');
      }, origin);
    }) as typeof doc.transact;

    expect(() => {
      applyExternalChange(durabilityState, hp, docName, '# After-Mutation\n');
    }).toThrow(/synthetic/);

    expect(doc.getText('source').toString()).toBe('# After-Mutation\n');
    expect(durabilityState.getReconciledBase(docName)).toBe('# After-Mutation\n');

    doc.transact = originalTransact as typeof doc.transact;
    await conn.disconnect();
  });

  test('preserves the original bridge violation when recovery snapshot persistence also fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-external-double-failure-'));
    const persistencePath = join(dir, 'state.json');
    const state = new DocumentDurabilityState('main', { persistencePath });
    const docName = 'double-failure';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);
    const originalTransact = doc.transact.bind(doc);
    const originalError = new BridgeInvariantViolationError({
      site: 'observer-b',
      docName,
      ytextSnapshot: SECRET_YTEXT,
      fragmentMdSnapshot: SECRET_FRAGMENT,
      unifiedDiff: SECRET_DIFF,
      stack: undefined,
    });
    const errorSpy = vi.spyOn(getLogger('reconcile'), 'error');
    try {
      applyExternalChange(state, hp, docName, '# Original\n');
      state.recordDisplacedVersion(docName, 'old');
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      doc.transact = ((fn: () => void, origin: unknown) => {
        originalTransact(() => {
          fn();
          throw originalError;
        }, origin);
      }) as typeof doc.transact;
      let actualError: unknown;
      try {
        applyExternalChange(state, hp, docName, '# Next\n');
      } catch (cause) {
        actualError = cause;
      }
      expect(actualError).toBe(originalError);
      expect(doc.getText('source').toString()).toBe('# Next\n');
      expect(state.getReconciledBase(docName)).toBe('# Original\n');

      const serialized = JSON.stringify(loggedReconcileErrorPayload(errorSpy));
      for (const secret of [SECRET_YTEXT, SECRET_FRAGMENT, SECRET_DIFF]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain('bridge-invariant-violation');
      expect(serialized).toContain('"redacted":true');
    } finally {
      errorSpy.mockRestore();
      doc.transact = originalTransact as typeof doc.transact;
      await conn.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('redacts merge content loss and keeps ordinary failures diagnosable in the same field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-external-redaction-'));
    const persistencePath = join(dir, 'state.json');
    const state = new DocumentDurabilityState('main', { persistencePath });
    const docName = 'redaction';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);
    const originalTransact = doc.transact.bind(doc);
    const contentLoss = new BridgeMergeContentLossError({
      which: 'substring',
      side: 'user',
      baseline: SECRET_YTEXT,
      userText: SECRET_FRAGMENT,
      agentText: SECRET_DIFF,
      result: '',
      lostSubstrings: [SECRET_YTEXT],
    });
    const ordinary = new Error('atomic rename failed with EACCES');
    const errorSpy = vi.spyOn(getLogger('reconcile'), 'error');
    try {
      applyExternalChange(state, hp, docName, '# Original\n');
      state.recordDisplacedVersion(docName, 'old');
      renameSync(persistencePath, `${persistencePath}.backup`);
      mkdirSync(persistencePath);
      let thrown: unknown = contentLoss;
      doc.transact = ((fn: () => void, origin: unknown) => {
        originalTransact(() => {
          fn();
          throw thrown;
        }, origin);
      }) as typeof doc.transact;

      expect(() => applyExternalChange(state, hp, docName, '# Loss\n')).toThrow(contentLoss);
      const lossPayload = JSON.stringify(loggedReconcileErrorPayload(errorSpy));
      for (const secret of [SECRET_YTEXT, SECRET_FRAGMENT, SECRET_DIFF]) {
        expect(lossPayload).not.toContain(secret);
      }
      expect(lossPayload).toContain('bridge-merge-content-loss');
      expect(lossPayload).toContain('"redacted":true');

      errorSpy.mockClear();
      thrown = ordinary;
      expect(() => applyExternalChange(state, hp, docName, '# Ordinary\n')).toThrow(ordinary);
      const payload = loggedReconcileErrorPayload(errorSpy);
      expect(payload.originalError).toBe('atomic rename failed with EACCES');
      expect(JSON.stringify(payload.originalError)).not.toBe('{}');
    } finally {
      errorSpy.mockRestore();
      doc.transact = originalTransact as typeof doc.transact;
      await conn.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createExternalChangeHandler — error-swallowing factory', () => {
  let hp: Hocuspocus;
  let durabilityState: DocumentDurabilityState;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
    durabilityState = new DocumentDurabilityState();
  });

  test('factory wrapper catches and logs when applyExternalChange throws', async () => {
    const errorSpy = vi.spyOn(getLogger('file-watcher'), 'error');

    try {
      const handler = createExternalChangeHandler(durabilityState, hp);
      const docName = 'test-throw-path';
      const conn = await hp.openDirectConnection(docName);

      const doc = getDoc(conn);
      const originalGetXmlFragment = doc.getXmlFragment.bind(doc);
      doc.getXmlFragment = () => {
        throw new Error('synthetic getXmlFragment failure');
      };

      doc.getText('source').insert(0, '# Original\n');
      const textBefore = doc.getText('source').toString();

      await expect(handler(docName, '# Content\n')).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      const callArgs = errorSpy.mock.calls[0] ?? [];
      expect(String(callArgs[1])).toContain('Failed to apply external change');
      expect(String(callArgs[1])).toContain(docName);

      expect(doc.getText('source').toString()).toBe(textBefore);

      doc.getXmlFragment = originalGetXmlFragment;
      await conn.disconnect();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('factory wrapper re-throws BridgeInvariantViolationError to preserve loud-failure gate', async () => {
    const errorSpy = vi.spyOn(getLogger('file-watcher'), 'error');

    try {
      const handler = createExternalChangeHandler(durabilityState, hp);
      const docName = 'test-bridge-violation-rethrow';
      const conn = await hp.openDirectConnection(docName);

      const doc = getDoc(conn);
      const originalGetXmlFragment = doc.getXmlFragment.bind(doc);
      doc.getXmlFragment = () => {
        throw new BridgeInvariantViolationError({
          site: 'observer-b',
          docName,
          ytextSnapshot: 'left',
          fragmentMdSnapshot: 'right',
          unifiedDiff: '',
          stack: undefined,
        });
      };

      await expect(handler(docName, '# Content\n')).rejects.toBeInstanceOf(
        BridgeInvariantViolationError,
      );

      expect(errorSpy).not.toHaveBeenCalled();

      doc.getXmlFragment = originalGetXmlFragment;
      await conn.disconnect();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('factory wrapper re-throws BridgeMergeContentLossError to preserve OK_RETHROW_BRIDGE_LOSS gate', async () => {
    const errorSpy = vi.fn(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      const handler = createExternalChangeHandler(durabilityState, hp);
      const docName = 'test-merge-loss-rethrow';
      const conn = await hp.openDirectConnection(docName);

      const doc = getDoc(conn);
      const originalGetXmlFragment = doc.getXmlFragment.bind(doc);
      doc.getXmlFragment = () => {
        throw new BridgeMergeContentLossError({
          baseline: 'base',
          userText: 'user',
          agentText: 'agent',
          result: 'merged',
          lostSubstrings: ['lost-text'],
          which: 'user',
          side: 'left',
        });
      };

      await expect(handler(docName, '# Content\n')).rejects.toBeInstanceOf(
        BridgeMergeContentLossError,
      );

      expect(errorSpy).not.toHaveBeenCalled();

      doc.getXmlFragment = originalGetXmlFragment;
      await conn.disconnect();
    } finally {
      console.error = originalError;
    }
  });
});

describe('reportReconcileCheckFailed', () => {
  test('counts and logs a check-failed refusal with its failure detail, and ignores every other outcome', () => {
    resetMetrics();
    const warnSpy = vi.spyOn(getLogger('reconcile'), 'warn');
    try {
      const refused = reconcile({
        docName: 'check-failed-doc',
        base: 'A\n\nB\n\nC\n',
        ours: 'A\n\nX\n\nB edited\n\nC\n',
        theirs: 'A\n\nX\n\nB\n\nC\n',
      });
      const merged = reconcile({
        docName: 'merged-doc',
        base: 'A\n\nB\n',
        ours: 'A ours\n\nB\n',
        theirs: 'A\n\nB theirs\n',
      });

      reportReconcileCheckFailed('merged-doc', merged, 'watcher');
      reportReconcileCheckFailed('check-failed-doc', refused, 'branch-switch');

      expect(getMetrics().reconcileCheckFailed).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toEqual({
        docName: 'check-failed-doc',
        site: 'branch-switch',
        failure: { check: 'single-occurrence', outputBlockIndex: 2 },
      });
    } finally {
      warnSpy.mockRestore();
      resetMetrics();
    }
  });
});

describe('reconcileDiskBeforeAgentWrite keeps the live side only once the outside version is in history', () => {
  const docName = 'kept-live-doc';
  const base = 'A\n\nB\n\nC\n';
  const ours = 'A\n\nX\n\nB edited\n\nC\n';
  const theirs = 'A\n\nX\n\nB\n\nC\n';
  let contentDir: string;
  let document: Y.Doc;
  let durabilityState: DocumentDurabilityState;
  const conflicts = {
    raise: vi.fn(),
    dissolveReconcile: vi.fn(),
    fileOf: (name: string) => `${name}.md`,
  };

  const recorder = (keptLive: MergeHistoryRecorder['keptLive']): MergeHistoryRecorder => ({
    bothKept: vi.fn(),
    keptLive: vi.fn(keptLive),
  });

  const guard = (history: MergeHistoryRecorder) =>
    reconcileDiskBeforeAgentWrite(
      durabilityState,
      { documents: new Map([[docName, document]]) } as unknown as Hocuspocus,
      docName,
      contentDir,
      undefined,
      undefined,
      conflicts,
      history,
    );

  beforeEach(() => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-kept-live-')));
    document = new Y.Doc();
    document.getText('source').insert(0, ours);
    durabilityState = new DocumentDurabilityState();
    durabilityState.setReconciledBase(docName, base);
    writeFileSync(join(contentDir, `${docName}.md`), theirs, 'utf-8');
    conflicts.raise.mockClear();
  });

  afterEach(() => {
    document.destroy();
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('a confirmed history write moves the base to the outside bytes and reports kept-live', async () => {
    const history = recorder(() => Promise.resolve(true));
    const result = await guard(history);

    expect(result).toMatchObject({ reconciled: true, mergeOutcome: 'kept-live' });
    expect(history.keptLive).toHaveBeenCalledWith(
      docName,
      { side: 'theirs', bytes: theirs },
      'check-failed',
    );
    expect(durabilityState.getReconciledBase(docName)).toBe(theirs);
    expect(conflicts.raise).not.toHaveBeenCalled();
  });

  test('a history write that was not saved raises the reconcile conflict with all three stages and keeps the base', async () => {
    const result = await guard(recorder(() => Promise.resolve(false)));

    expect(result.reconciled).toBe(false);
    expect(conflicts.raise).toHaveBeenCalledWith({
      kind: 'reconcile',
      file: `${docName}.md`,
      reason: 'refused-too-large',
      stages: { base, ours, theirs },
    });
    expect(durabilityState.getReconciledBase(docName)).toBe(base);
  });
});

describe('buildReconcileWarning', () => {
  const reconciled = { reconciled: true, baseBytes: 10, diskBytes: 14 } as const;

  test('asks for a re-read only on the both-kept and kept-live outcomes', () => {
    expect(
      buildReconcileWarning({ ...reconciled, mergeOutcome: 'merged' })?.nextStep,
    ).toBeUndefined();
    expect(
      buildReconcileWarning({ ...reconciled, mergeOutcome: 'clean' })?.nextStep,
    ).toBeUndefined();
    expect(
      buildReconcileWarning({
        ...reconciled,
        mergeOutcome: 'both-kept',
        keptBlocks: { duplicated: 1, restoredDeletedHere: 0, restoredDeletedOutside: 0 },
      })?.nextStep,
    ).toBe('re-read');
    expect(buildReconcileWarning({ ...reconciled, mergeOutcome: 'kept-live' })?.nextStep).toBe(
      're-read',
    );
    expect(
      buildReconcileWarning({ reconciled: false, baseBytes: 0, diskBytes: 0 }),
    ).toBeUndefined();
  });

  const bothKept = (
    duplicated: number,
    restoredDeletedHere: number,
    restoredDeletedOutside: number,
  ) =>
    buildReconcileWarning({
      ...reconciled,
      mergeOutcome: 'both-kept',
      keptBlocks: { duplicated, restoredDeletedHere, restoredDeletedOutside },
    });

  test('duplicates only: names the duplicate and asks to remove it', () => {
    const warning = bothKept(2, 0, 0);
    expect(warning).toMatchObject({
      duplicatedBlocks: 2,
      restoredDeletedHere: 0,
      restoredDeletedOutside: 0,
    });
    expect(warning?.hint).toBe(
      'An out-of-band edit changed 2 blocks also edited here, so both versions were kept: the version here first, the out-of-band version directly under it. Your write landed; do not retry it. Re-read the document (e.g. `exec("cat <path>")`) and, if your task calls for it, remove the duplicate with an ordinary edit.',
    );
  });

  test('a deletion here undone: names this side as the one whose deletion was undone', () => {
    const warning = bothKept(0, 1, 0);
    expect(warning).toMatchObject({ duplicatedBlocks: 0, restoredDeletedHere: 1 });
    expect(warning?.hint).toBe(
      'The deletion here of 1 block was undone because the out-of-band edit changed it: the out-of-band version was restored. Your write landed; do not retry it. Re-read the document (e.g. `exec("cat <path>")`) and, if your task calls for it, delete the restored block again with an ordinary edit.',
    );
  });

  test('an out-of-band deletion undone beside duplicates: both sentences, no invitation to delete', () => {
    const warning = bothKept(1, 0, 1);
    expect(warning).toMatchObject({ duplicatedBlocks: 1, restoredDeletedOutside: 1 });
    expect(warning?.hint).toBe(
      'An out-of-band edit changed 1 block also edited here, so both versions were kept: the version here first, the out-of-band version directly under it. The out-of-band deletion of 1 block edited here was undone: the version here was kept. Your write landed; do not retry it. Re-read the document (e.g. `exec("cat <path>")`) and, if your task calls for it, remove the duplicate with an ordinary edit.',
    );
  });
});

describe('reportReconcileBothKept', () => {
  test('counts the merge once and only the blocks that landed twice', () => {
    resetMetrics();
    reportReconcileBothKept(
      'counted-doc',
      [
        { blockIndex: 0, base: 'A', ours: 'A ours', theirs: 'A theirs', landed: 'both' },
        { blockIndex: 1, base: 'B', ours: '', theirs: 'B theirs', landed: 'theirs' },
      ],
      'watcher',
    );
    expect(getMetrics().reconcileBothKept).toBe(1);
    expect(getMetrics().reconcileBothKeptBlocks).toBe(1);
    resetMetrics();
  });
});
