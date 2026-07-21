/**
 * LRU-idle eviction under capacity pressure.
 *
 * At the cap, `getSession` evicts the least-recently-used session whose idle
 * age clears the floor instead of refusing outright — a burst of writes to
 * many distinct docs streams through a bounded working set. When nothing is
 * idle-eligible, behavior degrades to the pre-eviction contract
 * (`AgentSessionCapacityError` → 503 at the HTTP boundary).
 *
 * Companion to `agent-sessions.test.ts` (session lifecycle) — kept separate
 * so this file can import from `vitest` directly.
 */
import type { Document } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  type AgentDirectConnection,
  AgentSessionCapacityError,
  AgentSessionManager,
  applyAgentMarkdownWrite,
  applyAgentUndo,
} from './agent-sessions.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

/**
 * Minimal Hocuspocus mock (mirrors the one in `agent-sessions.test.ts`):
 * every openDirectConnection returns a unique DC over a real per-doc Y.Doc so
 * UndoManager creation and transacts behave. `deferCreates` lets a test hold
 * session creation in the pending map to probe the capacity accounting.
 */
function createMockHocuspocus(options: { deferCreates?: boolean } = {}) {
  const ydocs = new Map<string, Y.Doc>();
  const pendingReleases: Array<() => void> = [];

  function makeDC(docName: string): AgentDirectConnection {
    let disconnected = false;
    let ydoc = ydocs.get(docName);
    if (!ydoc) {
      ydoc = new Y.Doc();
      ydocs.set(docName, ydoc);
    }
    const doc = {
      name: docName,
      getText: (name: string) => ydoc.getText(name),
      getMap: (name: string) => ydoc.getMap(name),
      getXmlFragment: (name: string) => ydoc.getXmlFragment(name),
      transact: (fn: () => void, origin?: unknown) => ydoc.transact(fn, origin),
      on: ydoc.on.bind(ydoc),
      off: ydoc.off.bind(ydoc),
    } as unknown as Document;
    return {
      document: doc,
      disconnect: async () => {
        disconnected = true;
      },
      isDisconnected: () => disconnected,
      transact: () => {},
    } as unknown as AgentDirectConnection;
  }

  return {
    releaseAllPending(): void {
      for (const release of pendingReleases.splice(0)) release();
    },
    openDirectConnection: async (docName: string): Promise<AgentDirectConnection> => {
      if (options.deferCreates) {
        await new Promise<void>((resolve) => {
          pendingReleases.push(resolve);
        });
      }
      return makeDC(docName);
    },
  };
}

let mockHocuspocus: ReturnType<typeof createMockHocuspocus>;

beforeEach(() => {
  mockHocuspocus = createMockHocuspocus();
  resetMetrics();
});

afterEach(() => {
  resetMetrics();
});

describe('LRU-idle eviction at the session cap', () => {
  test('a burst of creates past the cap streams through instead of throwing 503', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 4,
      minEvictableIdleMs: 0,
    });

    // 12 distinct docs — 3x the cap. Pre-eviction this threw
    // AgentSessionCapacityError at doc #5; now every create succeeds.
    for (let i = 0; i < 12; i++) {
      await manager.getSession(`burst-doc-${i}.md`, 'agent-burst');
      expect(manager.liveSessionCount).toBeLessThanOrEqual(4);
    }

    // The newest 4 survive; the earliest were evicted in LRU order.
    for (let i = 8; i < 12; i++) {
      expect(manager.hasSession(`burst-doc-${i}.md`, 'agent-burst')).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      expect(manager.hasSession(`burst-doc-${i}.md`, 'agent-burst')).toBe(false);
    }
    expect(manager.evictionCount).toBe(8);

    await manager.closeAll();
  });

  test('eviction picks the least-recently-used session — a getSession touch protects it', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 3,
      minEvictableIdleMs: 0,
    });

    await manager.getSession('doc-a.md', 'agent-lru');
    await manager.getSession('doc-b.md', 'agent-lru');
    await manager.getSession('doc-c.md', 'agent-lru');

    // Touch A — B becomes the LRU.
    await manager.getSession('doc-a.md', 'agent-lru');

    await manager.getSession('doc-d.md', 'agent-lru');

    expect(manager.hasSession('doc-b.md', 'agent-lru')).toBe(false);
    expect(manager.hasSession('doc-a.md', 'agent-lru')).toBe(true);
    expect(manager.hasSession('doc-c.md', 'agent-lru')).toBe(true);
    expect(manager.hasSession('doc-d.md', 'agent-lru')).toBe(true);

    await manager.closeAll();
  });

  test('a getLiveSession read also refreshes recency', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 3,
      minEvictableIdleMs: 0,
    });

    await manager.getSession('doc-a.md', 'agent-read');
    await manager.getSession('doc-b.md', 'agent-read');
    await manager.getSession('doc-c.md', 'agent-read');

    // Read A (the burst-diff path) — B becomes the LRU.
    expect(manager.getLiveSession('doc-a.md', 'agent-read')).toBeDefined();

    await manager.getSession('doc-d.md', 'agent-read');

    expect(manager.hasSession('doc-b.md', 'agent-read')).toBe(false);
    expect(manager.hasSession('doc-a.md', 'agent-read')).toBe(true);

    await manager.closeAll();
  });

  test('sessions younger than the idle floor are never evicted — capacity error is preserved', async () => {
    // A just-used session may belong to an in-flight request; with a floor
    // higher than the test's runtime nothing is eligible and the cap
    // degrades to the pre-eviction 503 contract.
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 2,
      minEvictableIdleMs: 60_000,
    });

    await manager.getSession('doc-a.md', 'agent-floor');
    await manager.getSession('doc-b.md', 'agent-floor');

    await expect(manager.getSession('doc-c.md', 'agent-floor')).rejects.toBeInstanceOf(
      AgentSessionCapacityError,
    );

    // Nothing was torn down under the (conceptually in-flight) sessions.
    expect(manager.hasSession('doc-a.md', 'agent-floor')).toBe(true);
    expect(manager.hasSession('doc-b.md', 'agent-floor')).toBe(true);
    expect(manager.evictionCount).toBe(0);

    await manager.closeAll();
  });

  test('existing-session reuse at the cap neither evicts nor throws', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 2,
      minEvictableIdleMs: 0,
    });

    const a = await manager.getSession('doc-a.md', 'agent-reuse');
    await manager.getSession('doc-b.md', 'agent-reuse');

    const aAgain = await manager.getSession('doc-a.md', 'agent-reuse');
    expect(aAgain).toBe(a);
    expect(manager.evictionCount).toBe(0);
    expect(manager.liveSessionCount).toBe(2);

    await manager.closeAll();
  });

  test('eviction runs the disconnect teardown spine: DC disconnected, UM destroyed, entry removed', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 1,
      minEvictableIdleMs: 0,
    });

    const victim = await manager.getSession('doc-victim.md', 'agent-teardown');
    await manager.getSession('doc-new.md', 'agent-teardown');

    expect(manager.hasSession('doc-victim.md', 'agent-teardown')).toBe(false);
    expect((victim.dc as unknown as { isDisconnected: () => boolean }).isDisconnected()).toBe(true);
    // um.destroy() ran — the stack is empty and no longer tracking.
    expect(victim.um.undoStack.length).toBe(0);

    await manager.closeAll();
  });

  test('undo after eviction fails cleanly: hasSession is false and a fresh session has no undo stack', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 1,
      minEvictableIdleMs: 0,
    });

    const session = await manager.getSession('doc-undo.md', 'agent-undo-evict');
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Before eviction\n', 'replace');
    }, session.origin);
    session.um.stopCapturing();
    expect(session.um.undoStack.length).toBeGreaterThan(0);

    // Pressure-evict by creating a session on another doc.
    await manager.getSession('doc-other.md', 'agent-undo-evict');

    // The HTTP undo handler guards on hasSession before resolving a session;
    // an evicted (docName, agentId) reads as absent → the handler's
    // no-active-session refusal, never a write against torn-down state.
    expect(manager.hasSession('doc-undo.md', 'agent-undo-evict')).toBe(false);

    // A later getSession mints a FRESH session: empty undo stack, undo is a
    // clean no-op (returns false), document content untouched.
    const fresh = await manager.getSession('doc-undo.md', 'agent-undo-evict');
    expect(fresh).not.toBe(session);
    expect(fresh.um.undoStack.length).toBe(0);
    expect(applyAgentUndo(fresh, 'session')).toBe(false);
    expect(fresh.dc.document.getText('source').toString()).toBe('# Before eviction\n');

    await manager.closeAll();
  });

  test('writer identity is continuous across eviction: same session_id, fresh origin object', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 1,
      minEvictableIdleMs: 0,
    });

    const before = await manager.getSession('doc-attr.md', 'agent-85aabbcc');
    await manager.getSession('doc-fill.md', 'agent-85aabbcc');
    const after = await manager.getSession('doc-attr.md', 'agent-85aabbcc');

    // resolveWriterFromOrigin derives the shadow-repo writerId from
    // context.session_id — identical before/after, so attribution chains
    // continue under the same `agent-<id>` writer.
    expect(after.origin.context.session_id).toBe(before.origin.context.session_id);
    expect(after.origin.context.session_id).toBe('85aabbcc');
    // The frozen origin object itself is fresh (Set-identity for the new
    // session's UndoManager trackedOrigins).
    expect(after.origin).not.toBe(before.origin);

    await manager.closeAll();
  });

  test('pending (in-flight) session creations are never evicted and hold their capacity slot', async () => {
    const deferred = createMockHocuspocus({ deferCreates: true });
    const manager = new AgentSessionManager(deferred as never, {
      maxSessions: 1,
      minEvictableIdleMs: 0,
    });

    // Start a create and leave it pending — it occupies the only slot from
    // the pending map, where eviction cannot reach it.
    const pending = manager.getSession('doc-pending.md', 'agent-pending');

    // A second distinct create finds the slot held by a pending entry and
    // nothing evictable in the live map → capacity refusal.
    await expect(manager.getSession('doc-other.md', 'agent-pending')).rejects.toBeInstanceOf(
      AgentSessionCapacityError,
    );

    deferred.releaseAllPending();
    const session = await pending;
    expect(session.docName).toBe('doc-pending.md');
    expect(manager.hasSession('doc-pending.md', 'agent-pending')).toBe(true);

    await manager.closeAll();
  });

  test('evictions increment the in-process metrics counter', async () => {
    const manager = new AgentSessionManager(mockHocuspocus as never, {
      maxSessions: 1,
      minEvictableIdleMs: 0,
    });

    expect(getMetrics().agentSessionEvictions).toBe(0);
    await manager.getSession('doc-m1.md', 'agent-metrics');
    await manager.getSession('doc-m2.md', 'agent-metrics');
    await manager.getSession('doc-m3.md', 'agent-metrics');
    expect(getMetrics().agentSessionEvictions).toBe(2);
    expect(manager.evictionCount).toBe(2);

    await manager.closeAll();
  });
});
