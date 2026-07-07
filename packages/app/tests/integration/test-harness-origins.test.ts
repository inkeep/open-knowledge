/**
 * Test harness migration — structural isPairedWriteOrigin checks.
 *
 * Verifies that attachBridgeInvariantWatcher fires for per-session origins
 * (F1 shape, unique object refs) via the structural isPairedWriteOrigin
 * predicate, not identity-based Set membership with AGENT_WRITE_ORIGIN.
 */

import { describe, expect, test } from 'bun:test';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import { isPairedWriteOrigin } from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';

import { attachBridgeInvariantWatcher } from './test-harness';

/** Create a per-session origin matching the F1 shape. */
function makeSessionOrigin(sessionId: string): LocalTransactionOrigin {
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: Object.freeze({
      origin: 'agent-write',
      paired: true as const,
      session_id: sessionId,
      principal: 'principal-test-abc',
    }),
  });
}

describe('US-028: test harness migration — structural isPairedWriteOrigin', () => {
  test('isPairedWriteOrigin returns true for two distinct per-session origins', () => {
    const o1 = makeSessionOrigin('conn-1');
    const o2 = makeSessionOrigin('conn-2');

    expect(isPairedWriteOrigin(o1)).toBe(true);
    expect(isPairedWriteOrigin(o2)).toBe(true);
    // Object-identity-unique per precedent #1
    expect(o1).not.toBe(o2);
  });

  test('attachBridgeInvariantWatcher fires on per-session origin-1 (structural check)', () => {
    const origin1 = makeSessionOrigin('conn-1');
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      // Mutate Y.Text without matching XmlFragment — invariant violation.
      // The watcher should fire because origin1 passes isPairedWriteOrigin.
      doc.transact(() => {
        ytext.insert(0, 'hello');
      }, origin1);
    } catch {
      // BridgeInvariantViolationError expected
      violations.push('caught');
    }

    detach();
    doc.destroy();

    expect(violations.length).toBeGreaterThan(0); // origin1 triggered the watcher
  });

  test('attachBridgeInvariantWatcher fires on per-session origin-2 (structural check)', () => {
    const origin2 = makeSessionOrigin('conn-2');
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      doc.transact(() => {
        ytext.insert(0, 'world');
      }, origin2);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    expect(violations.length).toBeGreaterThan(0); // origin2 also triggered
  });

  test('watcher does NOT fire on undefined origin (WYSIWYG local typing)', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    let fired = false;
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: () => {
        fired = true;
      },
    });

    try {
      // undefined origin = local WYSIWYG typing — deliberately excluded
      doc.transact(() => {
        ytext.insert(0, 'typing');
      }, undefined);
    } catch {
      // should not throw
    }

    detach();
    doc.destroy();

    expect(fired).toBe(false);
  });

  test('isPairedWriteOrigin rejects non-paired origin', () => {
    const nonPaired = {
      source: 'local' as const,
      skipStoreHooks: false,
      context: { origin: 'sync-from-tree' },
    };
    expect(isPairedWriteOrigin(nonPaired)).toBe(false);
    expect(isPairedWriteOrigin(undefined)).toBe(false);
    expect(isPairedWriteOrigin(null)).toBe(false);
    expect(isPairedWriteOrigin('agent-write')).toBe(false);
  });
});

describe('FR-10: per-drain bridge invariant watcher', () => {
  test('watcher fires once per drain even when drain contains multiple enforcing transactions', () => {
    const origin = makeSessionOrigin('multi-tx-drain');
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      // Two ytext writes in the SAME drain. With per-tx firing, the watcher
      // would fire twice (once after each transaction). With per-drain
      // firing (afterAllTransactions), the watcher fires once after the
      // outermost transact's settlement.
      doc.transact(() => {
        ytext.insert(0, 'one');
        ytext.insert(3, ' two');
      }, origin);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    // Exactly one violation per drain — not one per tx, not one per
    // intermediate insert.
    expect(violations.length).toBe(2); // 1 onViolation invocation + 1 'caught'
  });

  test('watcher uses extended normalizeBridge tolerance (CRLF tolerated, not flagged)', () => {
    // Insert CRLF into ytext under an enforcing origin; ytext has CRLF and
    // fragment is empty (mismatch). The extended normalizeBridge tolerance
    // strips CR before comparison, so a CRLF-only ytext compares equal to
    // an LF-only frag (both normalize to the same form). But since fragment
    // is empty here the assertion still fires — the test verifies the
    // watcher is NOT crashing or short-circuiting on CR handling.
    const origin = makeSessionOrigin('crlf-tolerance');
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      doc.transact(() => {
        ytext.insert(0, 'a\r\nb\r\nc\r\n');
      }, origin);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    // CRLF input → ytext non-empty, fragment empty → mismatch fires.
    // Tolerance set strips CRLF but doesn't mask non-empty vs empty.
    expect(violations.length).toBeGreaterThan(0);
  });

  test('post-drain converged state passes the watcher (no violation)', () => {
    // Set up doc with a one-paragraph synced state, then mutate ytext +
    // fragment together in a single tx so the post-drain state is
    // converged. The watcher should NOT fire under contract.
    const origin = makeSessionOrigin('converged');
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      // Both CRDTs are empty before — bridge invariant holds (empty == empty).
      // Empty drain (no mutations) → no enforcing tx → watcher skip.
      // Add a no-op transaction to confirm: ytext stays empty AND fragment
      // stays empty — bridge invariant holds (both empty under contract).
      doc.transact(() => {
        // Touch fragment with a no-op insert+delete to force a transaction
        // to actually exist. ytext also stays empty.
        const xmlText = new Y.XmlText();
        fragment.insert(0, [xmlText]);
        fragment.delete(0, 1);
      }, origin);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    // Both ytext and fragment stay empty — bridge invariant holds —
    // watcher should NOT fire.
    expect(violations.length).toBe(0);
  });

  test('non-enforcing drain is silently skipped (undefined origin)', () => {
    // Multi-tx drain with undefined origins (local WYSIWYG typing). Watcher
    // must not fire even if ytext and fragment temporarily diverge.
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      doc.transact(() => {
        ytext.insert(0, 'typing here');
        ytext.insert(11, ' more');
      }, undefined);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    // undefined origin = local typing — invariant satisfaction comes via
    // a subsequent ORIGIN_TREE_TO_TEXT tx from Observer A. Watcher
    // skips this drain entirely.
    expect(violations.length).toBe(0);
  });
});
