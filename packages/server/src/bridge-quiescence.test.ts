/**
 * Unit tests for the per-doc quiescence tracker.
 *
 * Drives the tracker against a real Y.Doc — `attach` hooks afterTransaction
 * and afterAllTransactions; user-origin transactions bump the user counter,
 * settlement bumps the settled counter; quiescent ⇔ settled > userTx.
 *
 * Observer-self transactions (origin.context.origin === 'observer-sync')
 * MUST NOT bump userTx — counting them would re-flip the gate every drain.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
  __resetQuiescenceForTests,
  attachQuiescenceTracker,
  getMsSinceLastUserTx,
  getQuiescenceCountersForTests,
  isDocQuiescent,
} from './bridge-quiescence.ts';
import { OBSERVER_SYNC_ORIGIN } from './server-observers.ts';

beforeEach(() => {
  __resetQuiescenceForTests();
});

afterEach(() => {
  __resetQuiescenceForTests();
});

describe('isDocQuiescent — initial state', () => {
  test('untracked doc is trivially quiescent', () => {
    const doc = new Y.Doc();
    expect(isDocQuiescent(doc)).toBe(true);
    doc.destroy();
  });

  test('attached doc with no transactions is trivially quiescent', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });
});

describe('user-origin transaction → settlement → quiescent', () => {
  test('a single user-origin transaction makes settled bump past userTx', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      doc.transact(() => {
        doc.getText('source').insert(0, 'hello');
      }, userOrigin);
      // After the drain ends, afterAllTransactions has fired.
      const c = getQuiescenceCountersForTests(doc);
      expect(c).toBeDefined();
      expect(c?.settledGen).toBeGreaterThan(c?.lastUserTxGen ?? -1);
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('user-origin transaction without settlement still leaves settled > userTx after drain ends', () => {
    // Yjs always fires afterAllTransactions after an outermost transact, so
    // by the time we observe state from outside the drain, settlement has
    // landed. This is not "racing" against settlement — it's the contract.
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      let busyMidDrain: boolean | null = null;
      doc.transact(() => {
        doc.getText('source').insert(0, 'mid-drain');
        // Inside the drain, before afterAll fires, the gate would say busy
        // (settled has not yet bumped past the userTx counter set by
        // afterTransaction... wait — afterTransaction fires AFTER tx body).
        // So inside fn() we haven't yet observed the user bump either.
        busyMidDrain = isDocQuiescent(doc);
      }, userOrigin);
      // Inside fn(), afterTransaction hasn't fired yet, so userTxGen still 0
      // and settledGen still 0 → quiescent (trivially). The post-drain
      // state has both bumped.
      expect(busyMidDrain).toBe(true);
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });
});

describe('observer-self transactions do NOT count as user-origin', () => {
  test('the actual OBSERVER_SYNC_ORIGIN constant is recognized by the structural matcher', () => {
    // Pin the structural-match contract: bridge-quiescence.ts can't import
    // OBSERVER_SYNC_ORIGIN directly (would create a circular dep — server-
    // observers.ts imports attachQuiescenceTracker from bridge-quiescence.ts),
    // so it matches the shape `context.origin === 'observer-sync'` instead.
    // If a refactor changes OBSERVER_SYNC_ORIGIN's shape (e.g., renames the
    // origin string, restructures `context`, etc.), the structural match
    // silently fails to recognize it — every observer-self write would then
    // count as user-origin, flipping the persistence quiescence gate to
    // "non-quiescent" forever and triggering deferral cascades.
    //
    // Importing the constant in the test file is safe (tests are leaves —
    // server-observers.ts doesn't import this test) and links the predicate
    // to the actual shape. Same precedent as
    // test-harness-origins.test.ts importing isPairedWriteOrigin.
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      doc.transact(() => {
        doc.getText('source').insert(0, 'observer-self-write');
      }, OBSERVER_SYNC_ORIGIN);
      const c = getQuiescenceCountersForTests(doc);
      expect(c).toBeDefined();
      // The actual exported constant is recognized as observer-self →
      // lastUserTxGen stays 0, settledGen bumps.
      expect(c?.lastUserTxGen).toBe(0);
      expect(c?.settledGen).toBeGreaterThan(0);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('OBSERVER_SYNC_ORIGIN-shaped origin does not bump userTx', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const observerSelfOrigin = {
        source: 'local',
        skipStoreHooks: true,
        context: { origin: 'observer-sync' },
      };
      doc.transact(() => {
        doc.getText('source').insert(0, 'observer-write');
      }, observerSelfOrigin);
      const c = getQuiescenceCountersForTests(doc);
      expect(c).toBeDefined();
      expect(c?.lastUserTxGen).toBe(0);
      // settledGen DID bump because afterAllTransactions still fires for
      // every drain regardless of origin.
      expect(c?.settledGen).toBeGreaterThan(0);
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test("user origin then observer-self: still quiescent — observer doesn't reverse the gate", () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      const observerSelfOrigin = {
        source: 'local',
        skipStoreHooks: true,
        context: { origin: 'observer-sync' },
      };
      doc.transact(() => {
        doc.getText('source').insert(0, 'A');
      }, userOrigin);
      // User tx → drain settles → quiescent
      expect(isDocQuiescent(doc)).toBe(true);
      doc.transact(() => {
        doc.getText('source').insert(1, 'B');
      }, observerSelfOrigin);
      // Observer-self tx → settled bumps but userTx does not → still quiescent
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });
});

describe('multiple user-origin transactions across drains', () => {
  test('two consecutive user transactions both leave gate quiescent post-drain', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      doc.transact(() => {
        doc.getText('source').insert(0, 'A');
      }, userOrigin);
      expect(isDocQuiescent(doc)).toBe(true);
      doc.transact(() => {
        doc.getText('source').insert(1, 'B');
      }, userOrigin);
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('multi-tx single drain: nested transacts share one settlement', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      doc.transact(() => {
        doc.getText('source').insert(0, 'A');
        // Nested transact: shares the outermost drain in Yjs semantics.
        // afterTransaction fires for both; afterAllTransactions fires once.
        doc.transact(() => {
          doc.getText('source').insert(1, 'B');
        }, userOrigin);
      }, userOrigin);
      const c = getQuiescenceCountersForTests(doc);
      expect(c).toBeDefined();
      // Two afterTransaction events bumped userTx; one afterAllTransactions
      // bumped settledGen. Settled is greater (it fires last in the drain).
      expect(c?.settledGen).toBeGreaterThan(c?.lastUserTxGen ?? -1);
      expect(isDocQuiescent(doc)).toBe(true);
    } finally {
      detach();
      doc.destroy();
    }
  });
});

describe('detach', () => {
  test('detached tracker stops bumping counters', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    const userOrigin = { source: 'connection', context: { kind: 'user' } };
    doc.transact(() => {
      doc.getText('source').insert(0, 'A');
    }, userOrigin);
    const before = getQuiescenceCountersForTests(doc);
    detach();
    doc.transact(() => {
      doc.getText('source').insert(1, 'B');
    }, userOrigin);
    const after = getQuiescenceCountersForTests(doc);
    expect(after).toEqual(before);
    doc.destroy();
  });
});

describe('per-doc isolation', () => {
  test('two docs track independent quiescence state', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const detachA = attachQuiescenceTracker(docA);
    const detachB = attachQuiescenceTracker(docB);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      docA.transact(() => {
        docA.getText('source').insert(0, 'A');
      }, userOrigin);
      // docA settled, docB never observed any tx
      expect(isDocQuiescent(docA)).toBe(true);
      expect(isDocQuiescent(docB)).toBe(true);
      const cA = getQuiescenceCountersForTests(docA);
      const cB = getQuiescenceCountersForTests(docB);
      expect(cA?.lastUserTxGen).toBeGreaterThan(0);
      expect(cB).toBeUndefined(); // docB has no entry yet
    } finally {
      detachA();
      detachB();
      docA.destroy();
      docB.destroy();
    }
  });
});

describe('getMsSinceLastUserTx', () => {
  test('null when no user-origin tx observed', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      expect(getMsSinceLastUserTx(doc)).toBeNull();
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('returns delta from now to last tx (deterministic via test seam)', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      const txAtMs = Date.now();
      doc.transact(() => {
        doc.getText('source').insert(0, 'x');
      }, userOrigin);
      // The actual at-ms is set inside afterTransaction; close enough to txAtMs.
      const ageMs = getMsSinceLastUserTx(doc, txAtMs + 1000);
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(1100);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('clamps negative ageMs to 0 (clock skew defensive)', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      const userOrigin = { source: 'connection', context: { kind: 'user' } };
      doc.transact(() => {
        doc.getText('source').insert(0, 'x');
      }, userOrigin);
      // Pretend the clock went backwards
      const ageMs = getMsSinceLastUserTx(doc, 0);
      expect(ageMs).toBe(0);
    } finally {
      detach();
      doc.destroy();
    }
  });
});

describe('untracked-origin object — defensive parsing', () => {
  test('null origin treated as user-origin (bumps userTx)', () => {
    // Real Yjs operations that originate "from outside" any explicit
    // origin pass null/undefined. Treat them as user-origin (the
    // observer-self filter is the only thing that should suppress the
    // bump — anything else is a normal user/agent/external-tool write).
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      doc.transact(() => {
        doc.getText('source').insert(0, 'A');
      }); // no origin
      const c = getQuiescenceCountersForTests(doc);
      expect(c?.lastUserTxGen).toBeGreaterThan(0);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('origin without context still treated as user-origin', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      doc.transact(
        () => {
          doc.getText('source').insert(0, 'A');
        },
        { weird: 'origin' },
      );
      const c = getQuiescenceCountersForTests(doc);
      expect(c?.lastUserTxGen).toBeGreaterThan(0);
    } finally {
      detach();
      doc.destroy();
    }
  });

  test('origin with context.origin === observer-sync IS suppressed', () => {
    const doc = new Y.Doc();
    const detach = attachQuiescenceTracker(doc);
    try {
      doc.transact(
        () => {
          doc.getText('source').insert(0, 'A');
        },
        { context: { origin: 'observer-sync' } },
      );
      const c = getQuiescenceCountersForTests(doc);
      expect(c?.lastUserTxGen).toBe(0);
      expect(c?.settledGen).toBeGreaterThan(0);
    } finally {
      detach();
      doc.destroy();
    }
  });
});
