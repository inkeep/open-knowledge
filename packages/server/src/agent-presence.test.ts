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
    // Use a wall-clock-relative default so `setPresence`'s opportunistic
    // stale-entry eviction (BROADCASTER_EVICTION_MS = 20_000) doesn't drop
    // test entries whose ts is "ancient" relative to Date.now(). Tests that
    // want explicit ordering use small OFFSETS from this base.
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
    // Construct the expected entry ONCE and reuse it for both the write and
    // the assertion. `entry()` defaults `ts: Date.now()` — calling it twice
    // can straddle a millisecond tick on slower CI runners, producing a
    // spurious `toEqual` mismatch on the `ts` field (the only difference).
    // Pinning to a single object eliminates the wall-clock race.
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
    // Seed another agent's entry so the map isn't trivially empty.
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
    // Mode is preserved — unlike touchMode, bumpPresenceTs does not flip
    // writing→idle. That's the contract the keepalive-timer relies on: an
    // agent whose last state was `writing` continues to show the pulse
    // visual until its own touchMode('idle') arrives.
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
    // Simulate an awareness that throws from setLocalState (e.g. y-protocols
    // semantics shift, or a downstream change-subscriber crashing). The
    // broadcaster's catch swallows the throw and returns false; without the
    // counter, operators had only a pino ERROR line to alert on.
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
    // clearPresence walks through mutateAgentPresence and also tries the
    // throwing setLocalState — but clearPresence's fast-path short-circuits
    // when the agent is missing BEFORE the setLocalState call, so the
    // counter only advances when the mutation actually runs. Seed the map
    // with a direct state assignment so clearPresence reaches the throw.
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
    // None of these should throw, and all reads return empty.
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
    // Simulate the CC1 broadcaster or another subsystem seeding state first.
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
    // Regression: belt-and-suspenders against unbounded map growth when
    // the keepalive WS close never fires. Fresh agent-B's setPresence
    // drops the long-stale agent-A entry in the same sweep.
    const now = Date.now();
    const ancientTs = now - (5_000 * 4 + 1_000); // past the 20s eviction threshold
    broadcaster.setPresence('uuid-A-ghost', entry({ currentDoc: 'a.md', ts: ancientTs }));
    broadcaster.setPresence('uuid-B-live', entry({ currentDoc: 'b.md', ts: now }));
    const map = broadcaster.getPresenceMap();
    expect(Object.keys(map)).toEqual(['uuid-B-live']);
  });

  test('setPresence does NOT evict the agent being set, even if its prior entry was stale', () => {
    // Corner case: an agent's prior entry is ancient (proxy ate the close
    // frame; agent restarted with same id). Fresh setPresence with the
    // same id must take precedence — not evict itself during the sweep.
    const now = Date.now();
    const ancientTs = now - (5_000 * 4 + 1_000);
    broadcaster.setPresence('uuid-returning', entry({ currentDoc: 'old.md', ts: ancientTs }));
    broadcaster.setPresence('uuid-returning', entry({ currentDoc: 'new.md', ts: now }));
    const map = broadcaster.getPresenceMap();
    expect(map['uuid-returning'].currentDoc).toBe('new.md');
    expect(map['uuid-returning'].ts).toBe(now);
  });

  // ──────────────────────────────────────────────────────────────────
  // Handler try/finally contract
  // ──────────────────────────────────────────────────────────────────
  //
  // These tests pin the invariant that the three agent write handlers in
  // `api-extension.ts` depend on: when `setPresence(mode:'writing')` + the
  // transact are wrapped in a `try { ... } finally { touchMode('idle') }`,
  // any throw reaching the finally must still leave the broadcaster in
  // `mode:'idle'`. The fix was structural (moving setPresence
  // inside the try); these tests guard against a future refactor that
  // moves setPresence back out of the try (which would re-open the stuck-
  // writing race).
  //
  // Why at the broadcaster level: `mock.module` leaks across test files in
  // the same `bun test` process, so a
  // direct handler-unit test that forces `applyAgentMarkdownWrite` to throw
  // is impractical without process isolation. Instead, these tests encode
  // the exact try/finally shape the handlers use — if the shape changes,
  // the tests fail.
  //
  // Happy-path coverage for the handler is in
  // `packages/app/tests/integration/multi-agent-presence.test.ts` (a
  // successful write ends with `mode:'idle'`), which catches the other
  // half of the regression: a refactor that drops `touchMode('idle')`
  // entirely.

  test('contract: handler try/finally pattern — throw between setPresence and transact reaches touchMode', () => {
    // Mirrors the handler's exact shape:
    //   try {
    //     setPresence(agentId, {..., mode:'writing'});
    //     <throw point simulating transact failure>;
    //     <never-reached: recordContributor/etc>
    //   } finally {
    //     touchMode(agentId, 'idle');
    //   }
    const agentId = 'uuid-throw-during-transact';
    const thrown: Error[] = [];
    try {
      broadcaster.setPresence(
        agentId,
        entry({ currentDoc: 'doc.md', mode: 'writing', ts: Date.now() }),
      );
      // Verify setPresence landed before the throw — if this assert would
      // fail, the rest of the test would be meaningless.
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
    // If a future refactor moves setPresence OUTSIDE the try and a throw
    // fires before the try-entry, the handler's finally runs but no entry
    // exists. touchMode must not create a half-populated entry (invariant
    // re-asserted here in the handler-shape
    // context so a regression shows up in this suite). The stuck-editing
    // race is caught at a different layer — there is no 'editing' entry
    // to flip, so the client never sees one. This asserts the broadcaster
    // does not paper over the refactor regression by synthesizing an entry.
    const agentId = 'uuid-refactor-regression';
    try {
      throw new Error('simulated throw before setPresence');
    } catch {
      // swallow
    } finally {
      broadcaster.touchMode(agentId, 'idle');
    }
    const map = broadcaster.getPresenceMap();
    expect(map[agentId]).toBeUndefined();
  });

  test('principal-prefixed agentId is filtered at the broadcaster boundary (form-write writes never surface as agent presence)', () => {
    // Form-write handlers attribute writes to `principal-<UUID>` (precedent
    // #25 writer-ID taxonomy) — the local human editing their own properties
    // is the principal, not an agent. The structural test pins the
    // try/finally setPresence/touchMode shape, so write handlers can't omit
    // the calls at the source level. The broadcaster therefore filters
    // principal-prefixed ids internally so the awareness fanout stays free
    // of phantom-agent entries that would render as the user's own avatar
    // (presence badge in the editor chrome) or animate the body text in
    // agent colors via the agent-flash plugin.
    broadcaster.setPresence(
      'principal-deadbeef',
      entry({ displayName: 'Local User', currentDoc: 'a.md' }),
    );
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.touchMode('principal-deadbeef', 'idle');
    expect(broadcaster.getPresenceMap()).toEqual({});

    broadcaster.bumpPresenceTs('principal-deadbeef');
    expect(broadcaster.getPresenceMap()).toEqual({});

    // clearPresence is also gated — there's nothing to clear, but exercising
    // the path documents that principal ids never reach the awareness
    // mutation layer.
    broadcaster.clearPresence('principal-deadbeef');
    expect(broadcaster.getPresenceMap()).toEqual({});

    // An adjacent real agent's entry must remain unaffected — the filter is
    // per-id, not a global short-circuit.
    broadcaster.setPresence('agent-real', entry({ currentDoc: 'b.md' }));
    expect(Object.keys(broadcaster.getPresenceMap())).toEqual(['agent-real']);
    broadcaster.setPresence('principal-deadbeef', entry({ currentDoc: 'should-not-appear.md' }));
    expect(Object.keys(broadcaster.getPresenceMap())).toEqual(['agent-real']);
  });

  test('structural: every agent write handler pairs setPresence("writing") + touchMode("idle")', () => {
    // Source-level regression guard. Runtime equivalence is infeasible
    // because `mock.module` leaks across test files
    // ; this test reads the handler source and
    // asserts the try/finally shape. The runtime broadcaster-level tests
    // prove the pattern IS race-safe.
    //
    // The expected-match count is DISCOVERED from the source — counting
    // `applyAgentMarkdownWrite(` + `applyAgentUndo(` + `applyPatchToFm(`
    // call sites. That's the load-bearing signal of an "agent write
    // handler": every handler that dispatches an agent-origin CRDT mutation
    // must wrap it in the same try/finally + setPresence('writing') shape.
    // `extractAgentIdentity` call sites are too broad —
    // it's also called by admin handlers (rollback, create-page,
    // rename, save-version) that don't produce a live presence badge.
    //
    // Frontmatter form writes (browser PropertyPanel) bypass HTTP entirely
    // via `bindFrontmatterDoc.patch()` — they reach the YAML region of
    // `Y.Text('source')` through the WebSocket connection's origin, not an
    // HTTP handler. The MCP `frontmatter_patch` tool's `/api/frontmatter-patch`
    // handler IS an HTTP path and uses `applyPatchToFm` to splice the FM
    // region directly inside `session.dc.document.transact(..., session.origin)`
    // — counted here.
    //
    // If you are reading this because this test just failed:
    //   - If a NEW handler was added that calls applyAgentMarkdownWrite,
    //     applyAgentUndo, or applyPatchToFm: copy the setPresence/touchMode
    //     wiring from `handleAgentWriteMd` / `handleFrontmatterPatch` (the
    //     canonical patterns).
    //   - If a NEW composer is added (e.g. applyAgentRedo), extend the
    //     discovery regex to include it.
    //   - If an EXISTING handler was reformatted: the regexes tolerate
    //     whitespace, but structural tokens are load-bearing. Do NOT
    //     loosen the regex to pass — the invariant it guards (
    //     stuck-writing race) must hold for every handler.
    const dir = import.meta.dirname ?? new URL('.', import.meta.url).pathname;
    const src = readFileSync(resolve(dir, 'api-extension.ts'), 'utf-8');

    // Discover agent-write handlers via `applyAgentMarkdownWrite(` /
    // `applyAgentUndo(` / `applyPatchToFm(` call sites.
    const handlerCallSites = src.match(/apply(?:AgentMarkdownWrite|AgentUndo|PatchToFm)\(/g) ?? [];
    const expectedCount = handlerCallSites.length;
    expect(expectedCount).toBeGreaterThanOrEqual(5); // 3 write + 1 undo + 1 fm-patch

    // Each handler's try block must open with icon/color derivation
    // immediately followed by setPresence(mode:'writing'). Arbitrary
    // fields between the `{` and `mode: 'writing'` are allowed so
    // reordering the entry shape doesn't fail this test — only
    // relocating setPresence outside the try does.
    const tryShapePattern =
      /try\s*\{\s*const\s+icon\s*=\s*iconFromClientName\([^)]*\);\s*const\s+color\s*=\s*[\s\S]*?;\s*agentPresenceBroadcaster\?\.setPresence\(\s*agentId,\s*\{[\s\S]*?mode:\s*'writing'/g;
    const tryMatches = src.match(tryShapePattern) ?? [];
    expect(tryMatches.length).toBe(expectedCount);

    // Every handler's finally block must call touchMode('idle'). Drop
    // this pairing and the entry stays in 'writing' until the next
    // successful write or WS close.
    const finallyPattern =
      /finally\s*\{\s*agentPresenceBroadcaster\?\.touchMode\(agentId,\s*'idle'\);\s*\}/g;
    const finallyMatches = src.match(finallyPattern) ?? [];
    expect(finallyMatches.length).toBe(expectedCount);
  });
});
