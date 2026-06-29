import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hocuspocus } from '@hocuspocus/server';
import { type AgentPresenceEntry, SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { AgentPresenceBroadcaster } from './agent-presence.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

function makeMockAwareness() {
  let state: Record<string, unknown> | null = null;
  return {
    getLocalState: () => state,
    setLocalState: (next: Record<string, unknown> | null) => {
      state = next;
    },
    _read: () => state,
  };
}

function makeMockHocuspocus(awareness: ReturnType<typeof makeMockAwareness> | null) {
  const docs = new Map<string, { awareness: typeof awareness }>();
  if (awareness) docs.set(SYSTEM_DOC_NAME, { awareness });
  return { documents: docs } as unknown as Hocuspocus;
}

function entry(over: Partial<AgentPresenceEntry> = {}): AgentPresenceEntry {
  return {
    displayName: 'Claude',
    icon: 'claude',
    color: '#D97757',
    currentDoc: 'foo.md',
    mode: 'writing',
    ts: Date.now(),
    ...over,
  };
}

describe('AgentPresenceBroadcaster', () => {
  let awareness: ReturnType<typeof makeMockAwareness>;
  let broadcaster: AgentPresenceBroadcaster;

  beforeEach(() => {
    awareness = makeMockAwareness();
    broadcaster = new AgentPresenceBroadcaster(makeMockHocuspocus(awareness));
  });

  test('getPresenceMap starts empty', () => {
    expect(broadcaster.getPresenceMap()).toEqual({});
  });

  test('setPresence writes a keyed entry', () => {
    const e = entry({ displayName: 'Claude', currentDoc: 'a.md' });
    broadcaster.setPresence('uuid-A', e);
    expect(broadcaster.getPresenceMap()).toEqual({ 'uuid-A': e });
  });

  test('setPresence upserts existing agentId without clobbering other agents', () => {
    const base = Date.now();
    broadcaster.setPresence(
      'uuid-A',
      entry({ displayName: 'Claude', currentDoc: 'a.md', ts: base }),
    );
    broadcaster.setPresence(
      'uuid-B',
      entry({ displayName: 'Cursor', icon: 'cursor', currentDoc: 'b.md', ts: base + 100 }),
    );

    broadcaster.setPresence(
      'uuid-A',
      entry({ displayName: 'Claude', currentDoc: 'a2.md', ts: base + 200, mode: 'idle' }),
    );

    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map).sort()).toEqual(['uuid-A', 'uuid-B']);
    expect(map['uuid-A'].currentDoc).toBe('a2.md');
    expect(map['uuid-A'].mode).toBe('idle');
    expect(map['uuid-A'].ts).toBe(base + 200);
    expect(map['uuid-B'].currentDoc).toBe('b.md');
    expect(map['uuid-B'].displayName).toBe('Cursor');
  });

  test('clearPresence removes only the target agentId', () => {
    const base = Date.now();
    broadcaster.setPresence('uuid-A', entry({ currentDoc: 'a.md', ts: base }));
    broadcaster.setPresence('uuid-B', entry({ currentDoc: 'b.md', ts: base + 100 }));

    broadcaster.clearPresence('uuid-A');

    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map)).toEqual(['uuid-B']);
    expect(map['uuid-B'].currentDoc).toBe('b.md');
  });

  test('clearPresence on unknown agentId is a no-op', () => {
    const base = Date.now();
    broadcaster.setPresence('uuid-A', entry({ currentDoc: 'a.md', ts: base }));
    broadcaster.clearPresence('never-existed');

    expect(broadcaster.getPresenceMap()).toEqual({
      'uuid-A': entry({ currentDoc: 'a.md', ts: base }),
    });
  });

  test('touchMode updates mode + ts but preserves other fields', () => {
    broadcaster.setPresence(
      'uuid-A',
      entry({
        displayName: 'Claude',
        icon: 'claude',
        color: '#D97757',
        currentDoc: 'a.md',
        mode: 'writing',
        ts: Date.now(),
      }),
    );

    const before = Date.now();
    broadcaster.touchMode('uuid-A', 'idle');
    const after = Date.now();

    const map = broadcaster.getPresenceMap();
    expect(map['uuid-A'].displayName).toBe('Claude');
    expect(map['uuid-A'].icon).toBe('claude');
    expect(map['uuid-A'].color).toBe('#D97757');
    expect(map['uuid-A'].currentDoc).toBe('a.md');
    expect(map['uuid-A'].mode).toBe('idle');
    expect(map['uuid-A'].ts).toBeGreaterThanOrEqual(before);
    expect(map['uuid-A'].ts).toBeLessThanOrEqual(after);
  });

  test('touchMode is a no-op when the agent has no existing entry (never creates half-populated)', () => {
    broadcaster.setPresence('uuid-A', entry({ displayName: 'Claude', currentDoc: 'a.md' }));

    broadcaster.touchMode('uuid-ghost', 'writing');

    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map)).toEqual(['uuid-A']);
    expect(map['uuid-ghost']).toBeUndefined();
  });

  test('bumpPresenceTs refreshes ts without changing other fields', () => {
    const start = Date.now();
    broadcaster.setPresence(
      'uuid-A',
      entry({
        displayName: 'Claude',
        icon: 'claude',
        color: '#D97757',
        currentDoc: 'a.md',
        mode: 'writing',
        ts: start,
      }),
    );

    const beforeBump = Date.now();
    broadcaster.bumpPresenceTs('uuid-A');
    const afterBump = Date.now();

    const map = broadcaster.getPresenceMap();
    expect(map['uuid-A'].displayName).toBe('Claude');
    expect(map['uuid-A'].icon).toBe('claude');
    expect(map['uuid-A'].color).toBe('#D97757');
    expect(map['uuid-A'].currentDoc).toBe('a.md');
    expect(map['uuid-A'].mode).toBe('writing');
    expect(map['uuid-A'].ts).toBeGreaterThanOrEqual(beforeBump);
    expect(map['uuid-A'].ts).toBeLessThanOrEqual(afterBump);
  });

  test('bumpPresenceTs is a no-op when the agent has no existing entry', () => {
    broadcaster.setPresence('uuid-A', entry({ displayName: 'Claude', currentDoc: 'a.md' }));
    broadcaster.bumpPresenceTs('uuid-ghost');
    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map)).toEqual(['uuid-A']);
    expect(map['uuid-ghost']).toBeUndefined();
  });

  test('mutation failures increment agentPresenceMutationErrors counter (regression: silent-drop observability)', () => {
    resetMetrics();
    const throwingAwareness = {
      getLocalState: () => null,
      setLocalState: () => {
        throw new Error('simulated awareness teardown');
      },
    };
    const docs = new Map<string, { awareness: typeof throwingAwareness }>();
    docs.set(SYSTEM_DOC_NAME, { awareness: throwingAwareness });
    const failingBroadcaster = new AgentPresenceBroadcaster({
      documents: docs,
    } as unknown as Hocuspocus);

    expect(getMetrics().agentPresenceMutationErrors).toBe(0);
    failingBroadcaster.setPresence('uuid-fail', entry({ currentDoc: 'x.md' }));
    expect(getMetrics().agentPresenceMutationErrors).toBe(1);
    throwingAwareness.getLocalState = () => ({
      agentPresence: {
        'uuid-fail': entry({ currentDoc: 'x.md' }),
      },
    });
    failingBroadcaster.clearPresence('uuid-fail');
    expect(getMetrics().agentPresenceMutationErrors).toBe(2);
  });

  test('graceful no-op when __system__ document is missing', () => {
    const noopBroadcaster = new AgentPresenceBroadcaster(makeMockHocuspocus(null));
    noopBroadcaster.setPresence('uuid-A', entry({ currentDoc: 'foo.md' }));
    noopBroadcaster.clearPresence('uuid-A');
    noopBroadcaster.touchMode('uuid-A', 'idle');
    expect(noopBroadcaster.getPresenceMap()).toEqual({});
  });

  test('two agents coexist as separate map entries (bug-fix premise)', () => {
    const base = Date.now();
    broadcaster.setPresence(
      'uuid-A',
      entry({ displayName: 'Claude', icon: 'claude', currentDoc: 'a.md', ts: base }),
    );
    broadcaster.setPresence(
      'uuid-B',
      entry({ displayName: 'Cursor', icon: 'cursor', currentDoc: 'b.md', ts: base + 50 }),
    );

    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map).length).toBe(2);
    expect(map['uuid-A'].displayName).toBe('Claude');
    expect(map['uuid-A'].currentDoc).toBe('a.md');
    expect(map['uuid-B'].displayName).toBe('Cursor');
    expect(map['uuid-B'].currentDoc).toBe('b.md');
  });

  test('setPresence preserves unrelated awareness fields on __system__ state', () => {
    awareness.setLocalState({ someOtherField: { v: 1 } });

    broadcaster.setPresence('uuid-A', entry({ currentDoc: 'a.md' }));

    const state = awareness._read() as {
      someOtherField?: { v: number };
      agentPresence?: Record<string, AgentPresenceEntry>;
    };
    expect(state.someOtherField).toEqual({ v: 1 });
    expect(state.agentPresence?.['uuid-A']).toBeDefined();
  });

  test('setPresence opportunistically evicts entries beyond BROADCASTER_EVICTION_MS', () => {
    const now = Date.now();
    const ancientTs = now - (5_000 * 4 + 1_000); // past the 20s eviction threshold
    broadcaster.setPresence('uuid-A-ghost', entry({ currentDoc: 'a.md', ts: ancientTs }));
    broadcaster.setPresence('uuid-B-live', entry({ currentDoc: 'b.md', ts: now }));
    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map)).toEqual(['uuid-B-live']);
  });

  test('setPresence does NOT evict the agent being set, even if its prior entry was stale', () => {
    const now = Date.now();
    const ancientTs = now - (5_000 * 4 + 1_000);
    broadcaster.setPresence('uuid-returning', entry({ currentDoc: 'old.md', ts: ancientTs }));
    broadcaster.setPresence('uuid-returning', entry({ currentDoc: 'new.md', ts: now }));
    const map = broadcaster.getPresenceMap();
    expect(map['uuid-returning'].currentDoc).toBe('new.md');
    expect(map['uuid-returning'].ts).toBe(now);
  });

  test('contract: handler try/finally pattern — throw between setPresence and transact reaches touchMode', () => {
    const agentId = 'uuid-throw-during-transact';
    const thrown: Error[] = [];
    try {
      broadcaster.setPresence(
        agentId,
        entry({ currentDoc: 'doc.md', mode: 'writing', ts: Date.now() }),
      );
      expect(broadcaster.getPresenceMap()[agentId].mode).toBe('writing');
      throw new Error('simulated transact failure (applyAgentMarkdownWrite throw)');
    } catch (err) {
      thrown.push(err as Error);
    } finally {
      broadcaster.touchMode(agentId, 'idle');
    }
    expect(thrown).toHaveLength(1);
    const map = broadcaster.getPresenceMap();
    expect(map[agentId].mode).toBe('idle');
    expect(map[agentId].currentDoc).toBe('doc.md');
  });

  test('contract: touchMode before any setPresence is a no-op (handler finally on pre-setPresence throw)', () => {
    const agentId = 'uuid-refactor-regression';
    try {
      throw new Error('simulated throw before setPresence');
    } catch {
    } finally {
      broadcaster.touchMode(agentId, 'idle');
    }
    const map = broadcaster.getPresenceMap();
    expect(map[agentId]).toBeUndefined();
  });

  test('principal-prefixed agentId is filtered at the broadcaster boundary (form-write writes never surface as agent presence)', () => {
    broadcaster.setPresence(
      'principal-deadbeef',
      entry({ displayName: 'Local User', currentDoc: 'a.md' }),
    );
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.touchMode('principal-deadbeef', 'idle');
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.bumpPresenceTs('principal-deadbeef');
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.clearPresence('principal-deadbeef');
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.setPresence('agent-real', entry({ currentDoc: 'b.md' }));
    expect(Object.keys(broadcaster.getPresenceMap())).toEqual(['agent-real']);
    broadcaster.setPresence('principal-deadbeef', entry({ currentDoc: 'should-not-appear.md' }));
    expect(Object.keys(broadcaster.getPresenceMap())).toEqual(['agent-real']);
  });

  test('structural: every agent write handler pairs setPresence("writing") + touchMode("idle")', () => {
    const dir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
    const src = readFileSync(resolve(dir, 'api-extension.ts'), 'utf-8');

    const handlerCallSites = src.match(/apply(?:AgentMarkdownWrite|AgentUndo|PatchToFm)\(/g) ?? [];
    const expectedCount = handlerCallSites.length;
    expect(expectedCount).toBeGreaterThanOrEqual(5); // 3 write + 1 undo + 1 fm-patch

    const tryShapePattern =
      /try\s*\{\s*const\s+icon\s*=\s*iconFromClientName\([^)]*\);\s*const\s+color\s*=\s*[\s\S]*?;\s*agentPresenceBroadcaster\?\.setPresence\(\s*agentId,\s*\{[\s\S]*?mode:\s*'writing'/g;
    const tryMatches = src.match(tryShapePattern) ?? [];
    expect(tryMatches.length).toBe(expectedCount);

    const finallyPattern =
      /finally\s*\{\s*agentPresenceBroadcaster\?\.touchMode\(agentId,\s*'idle'\);\s*\}/g;
    const finallyMatches = src.match(finallyPattern) ?? [];
    expect(finallyMatches.length).toBe(expectedCount);
  });
});
