/**
 * Direct unit tests for the unified disk→CRDT bridge (`applyExternalChange`).
 *
 * Covers the 3 internal branches of the throwing helper:
 *   (a) document-missing → silent early return (no throw, no mutations)
 *   (b) frontmatter asymmetry → XmlFragment gets body only, Y.Text gets full content
 *   (c) Y.Text no-op → skip delete/insert when content unchanged
 *   (d) transaction origin → matches LocalTransactionOrigin shape
 *
 * Plus the factory wrapper's error-swallowing contract.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hocuspocus } from '@hocuspocus/server';
import {
  BridgeInvariantViolationError,
  BridgeMergeContentLossError,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import type * as Y from 'yjs';
import { applyExternalChange, createExternalChangeHandler } from './external-change.ts';
import { getReconciledBase, setReconciledBase } from './persistence.ts';

type Conn = Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;

function getDoc(conn: Conn): Y.Doc {
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  return doc;
}

describe('applyExternalChange — throwing helper', () => {
  let hp: Hocuspocus;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
  });

  test('(a) document-missing early return — no throw, no mutations', () => {
    expect(() => {
      applyExternalChange(hp, 'nonexistent-doc', '# Hello\n\nWorld\n');
    }).not.toThrow();
    expect(hp.documents.get('nonexistent-doc')).toBeUndefined();
  });

  test('(b) frontmatter asymmetry — XmlFragment gets body only, Y.Text gets full content (D8)', async () => {
    const docName = 'test-frontmatter-asymmetry';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const fullContent = '---\ntitle: Test\ntags: [a, b]\n---\n# Hello\n\nParagraph text.\n';

    applyExternalChange(hp, docName, fullContent);

    // Y.Text contains the FULL content (FM region IS the FM source of truth).
    const ytext = doc.getText('source');
    expect(ytext.toString()).toBe(fullContent);

    // FM extracted from the YAML region matches what was on disk.
    const { frontmatter } = stripFrontmatter(ytext.toString());
    expect(frontmatter).toContain('title: Test');
    expect(frontmatter).toContain('---');

    // XmlFragment contains body-derived nodes but NOT frontmatter text.
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
    applyExternalChange(hp, docName, content);

    let textMutations = 0;
    const ytext = doc.getText('source');
    const observer = () => {
      textMutations++;
    };
    ytext.observe(observer);

    applyExternalChange(hp, docName, content);

    ytext.unobserve(observer);
    expect(textMutations).toBe(0);

    await conn.disconnect();
  });

  test('(b3) malformed YAML round-trips into Y.Text verbatim (D31 — Y.Text is the source of truth)', async () => {
    const docName = 'test-malformed-yaml';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const malformed = '---\ntitle: [unterminated\nstatus: published\n---\n# Body\n';
    applyExternalChange(hp, docName, malformed);

    // Y.Text holds the malformed bytes verbatim — no defensive revert.
    expect(doc.getText('source').toString()).toBe(malformed);

    await conn.disconnect();
  });

  test('(b4) FM-indent preserved verbatim; body canonicalized to match XmlFragment (bridge invariant)', async () => {
    // Two parts of the same disk→CRDT contract:
    //   - FM region is preserved EXACTLY (user's YAML formatting,
    //     including `  - characters` indent, must round-trip).
    //   - Body region matches XmlFragment's canonical serialization
    //     (bridge invariant — `stripTrailingWhitespace(ytext) ===
    //     stripTrailingWhitespace(serialize(fragment))`). Markdown has
    //     multiple equivalent representations (doc-start `---` is
    //     a thematic break that serializes to canonical `***`); writing
    //     the raw disk bytes for these constructs would diverge.
    const docName = 'test-fm-indent-body-canonical';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const onDisk = '---\ntags:\n  - characters\n  - air-nomads\n---\n\n# Aang\n';
    applyExternalChange(hp, docName, onDisk);

    const ytext = doc.getText('source').toString();
    // FM region byte-identical to disk (preserves indent + scalar style).
    const { frontmatter } = stripFrontmatter(ytext);
    expect(frontmatter).toBe('---\ntags:\n  - characters\n  - air-nomads\n---\n');

    await conn.disconnect();
  });

  test('(b5) Y.Text-is-truth: doc-start `---` survives in Y.Text (no canonicalize-write-back)', async () => {
    // Y.Text-is-truth contract (precedent #38): under contract
    // Y.Text holds the user's source bytes. `---` and `***` at doc start are
    // both valid CommonMark thematic breaks — `normalizeBridge` tolerates
    // the equivalence so the bridge invariant still holds
    // even when ytext bytes differ from `serialize(fragment)` bytes.
    //
    // Pre-contract: ytext was canonicalized to `***\n` to match XmlFragment's
    // canonical serialization. Post-contract: ytext holds raw disk bytes
    // verbatim. The single watchdog assertion at the bridge invariant level
    // confirms the byte difference is tolerance-class-equal.
    const docName = 'test-thematic-break-raw';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    applyExternalChange(hp, docName, '---\n');

    const ytext = doc.getText('source').toString();
    // Under contract: ytext holds the raw disk bytes — `---\n` survives.
    expect(ytext).toBe('---\n');

    await conn.disconnect();
  });

  test('(c) Y.Text no-op — delete/insert skipped when content unchanged', async () => {
    const docName = 'test-ytext-noop';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    const content = '# Hello\n\nWorld\n';

    applyExternalChange(hp, docName, content);
    expect(doc.getText('source').toString()).toBe(content);

    let textMutations = 0;
    const ytext = doc.getText('source');
    const observer = () => {
      textMutations++;
    };
    ytext.observe(observer);

    applyExternalChange(hp, docName, content);

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

    applyExternalChange(hp, docName, '# Test\n');

    expect(capturedOrigin).toEqual({
      source: 'local',
      skipStoreHooks: true,
      context: { origin: 'file-watcher', paired: true },
    });

    await conn.disconnect();
  });

  test('(e) catch path on post-mutation transact throw sets reconciledBase to mutated ytext', async () => {
    // When applyFastDiff has already mutated Y.Text and updateYFragment
    // then throws, the transact's mutations stay applied (Yjs doesn't roll
    // back on throw). Without this fix, the transact-throw escapes the
    // outer caller, recordContributor and the post-transact
    // setReconciledBase(content) are skipped, and reconciledBase keeps
    // pointing at OLD content. The next persistence flush would compare
    // ytext (NEW, post-applyFastDiff) against reconciledBase (OLD), see
    // them differ, and write ytext bytes to disk — typically idempotent
    // (ytext === current disk), but under back-to-back disk edits within
    // the persistence debounce window this could overwrite a newer disk
    // version with the post-throw ytext state.
    //
    // The catch path's setReconciledBase(current ytext) bounds the race:
    // the next persistence-flush compare matches (ytext === reconciledBase)
    // and skips the write. Recovery converges via the next file-watcher
    // event or user mutation.
    const docName = 'test-catch-bounds-post-mutation';
    const conn = await hp.openDirectConnection(docName);
    const doc = getDoc(conn);

    // Establish initial state via a successful apply.
    applyExternalChange(hp, docName, '# Original\n');
    setReconciledBase(docName, '# Original\n');
    expect(doc.getText('source').toString()).toBe('# Original\n');
    expect(getReconciledBase(docName)).toBe('# Original\n');

    // Wrap doc.transact so it runs the inner mutations normally, then
    // throws after — simulating "applyFastDiff succeeded, updateYFragment
    // threw". Mutations stay applied because Yjs doesn't roll back on
    // throw.
    const originalTransact = doc.transact.bind(doc);
    doc.transact = ((fn: () => void, origin: unknown) => {
      originalTransact(() => {
        fn();
        throw new Error('synthetic post-mutation transact failure');
      }, origin);
    }) as typeof doc.transact;

    expect(() => {
      applyExternalChange(hp, docName, '# After-Mutation\n');
    }).toThrow(/synthetic/);

    // ytext WAS mutated by applyFastDiff before the synthetic throw.
    expect(doc.getText('source').toString()).toBe('# After-Mutation\n');
    // The catch path set reconciledBase to current ytext content. WITHOUT
    // the fix, reconciledBase would still equal '# Original\n' (the post-
    // transact setReconciledBase('# After-Mutation\n') is skipped on
    // throw), and persistence would see ytext ≠ reconciledBase and write.
    expect(getReconciledBase(docName)).toBe('# After-Mutation\n');

    doc.transact = originalTransact as typeof doc.transact;
    await conn.disconnect();
  });
});

describe('createExternalChangeHandler — error-swallowing factory', () => {
  let hp: Hocuspocus;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
  });

  test('factory wrapper catches and logs when applyExternalChange throws', async () => {
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      const handler = createExternalChangeHandler(hp);
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
      const callArgs = errorSpy.mock.calls[0];
      expect(callArgs[0]).toContain('Failed to apply external change');
      expect(callArgs[0]).toContain(docName);

      expect(doc.getText('source').toString()).toBe(textBefore);

      doc.getXmlFragment = originalGetXmlFragment;
      await conn.disconnect();
    } finally {
      console.error = originalError;
    }
  });

  test('factory wrapper re-throws BridgeInvariantViolationError to preserve loud-failure gate', async () => {
    // Contract-gate errors are loud-failure signals in NODE_ENV=test (or with
    // OK_BRIDGE_THROW_ON_VIOLATION=1). Swallowing them here would silently
    // subvert the test gate and let real bridge bugs land green. The wrapper
    // must let them propagate.
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      const handler = createExternalChangeHandler(hp);
      const docName = 'test-bridge-violation-rethrow';
      const conn = await hp.openDirectConnection(docName);

      const doc = getDoc(conn);
      const originalGetXmlFragment = doc.getXmlFragment.bind(doc);
      // Inject a synthetic BridgeInvariantViolationError where any post-load
      // operation runs. The wrapper's catch must re-throw this rather than
      // log-and-swallow.
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

      // Routine error path was NOT taken — log line is the loud-failure throw,
      // not the swallow path's `Failed to apply external change` message.
      expect(errorSpy).not.toHaveBeenCalled();

      doc.getXmlFragment = originalGetXmlFragment;
      await conn.disconnect();
    } finally {
      console.error = originalError;
    }
  });

  test('factory wrapper re-throws BridgeMergeContentLossError to preserve OK_RETHROW_BRIDGE_LOSS gate', async () => {
    // Same rationale as the BridgeInvariantViolationError case — content-loss
    // signals from Path B must reach the test runner under
    // OK_RETHROW_BRIDGE_LOSS=1 / NODE_ENV=test, not get swallowed by the
    // dev-plugin file-watcher wrapper.
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;

    try {
      const handler = createExternalChangeHandler(hp);
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
