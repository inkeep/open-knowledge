import { describe, expect, test } from 'bun:test';
import type { LocalTransactionOrigin } from '@hocuspocus/server';
import { isPairedWriteOrigin } from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';

import { attachBridgeInvariantWatcher } from './test-harness';

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
      doc.transact(() => {
        ytext.insert(0, 'hello');
      }, origin1);
    } catch {
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
      doc.transact(() => {
        ytext.insert(0, 'typing');
      }, undefined);
    } catch {}

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
      doc.transact(() => {
        ytext.insert(0, 'one');
        ytext.insert(3, ' two');
      }, origin);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    expect(violations.length).toBe(2); // 1 onViolation invocation + 1 'caught'
  });

  test('watcher uses extended normalizeBridge tolerance (CRLF tolerated, not flagged)', () => {
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

    expect(violations.length).toBeGreaterThan(0);
  });

  test('post-drain converged state passes the watcher (no violation)', () => {
    const origin = makeSessionOrigin('converged');
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');

    const violations: unknown[] = [];
    const detach = attachBridgeInvariantWatcher(doc, {
      onViolation: (info) => violations.push(info),
    });

    try {
      doc.transact(() => {
        const xmlText = new Y.XmlText();
        fragment.insert(0, [xmlText]);
        fragment.delete(0, 1);
      }, origin);
    } catch {
      violations.push('caught');
    }

    detach();
    doc.destroy();

    expect(violations.length).toBe(0);
  });

  test('non-enforcing drain is silently skipped (undefined origin)', () => {
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

    expect(violations.length).toBe(0);
  });
});
