import { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { applyExternalChange, createExternalChangeHandler } from './external-change.ts';
import { getLogger } from './logger.ts';

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn): Y.Doc {
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
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
