import { describe, expect, test } from 'bun:test';
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import {
  AGENT_PRESENCE_STALE_MS,
  type AgentPresenceAwareness,
  type AgentPresenceState,
  hasAgentPresenceShape,
  pickAgentsForDoc,
} from './agent-presence';

function makeAwareness(states: AgentPresenceState[]): AgentPresenceAwareness {
  const map = new Map<number, AgentPresenceState>();
  for (const [i, s] of states.entries()) {
    map.set(i, s);
  }
  return { getStates: () => map };
}

function entry(over: Partial<AgentPresenceEntry> = {}): AgentPresenceEntry {
  return {
    displayName: 'Claude',
    icon: 'claude',
    color: '#D97757',
    currentDoc: 'foo.md',
    mode: 'writing',
    ts: 10_000,
    ...over,
  };
}

describe('pickAgentsForDoc', () => {
  const NOW = 10_000;

  test('returns two empty arrays when awareness is empty', () => {
    expect(pickAgentsForDoc(makeAwareness([]), 'foo.md', NOW)).toEqual({
      current: [],
      crossDoc: [],
    });
  });

  test('single agent on active doc lands in current', () => {
    const e = entry({ currentDoc: 'foo.md', ts: NOW });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-A': e } }]);
    expect(pickAgentsForDoc(awareness, 'foo.md', NOW)).toEqual({
      current: [{ agentId: 'uuid-A', entry: e }],
      crossDoc: [],
    });
  });

  test('single agent on different doc lands in crossDoc', () => {
    const e = entry({ currentDoc: 'bar.md', ts: NOW });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-A': e } }]);
    expect(pickAgentsForDoc(awareness, 'foo.md', NOW)).toEqual({
      current: [],
      crossDoc: [{ agentId: 'uuid-A', entry: e }],
    });
  });

  test('two agents, one per doc, split by active doc', () => {
    const onFoo = entry({ currentDoc: 'foo.md', ts: NOW });
    const onBar = entry({ currentDoc: 'bar.md', ts: NOW, displayName: 'Cursor', icon: 'cursor' });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-A': onFoo, 'uuid-B': onBar } }]);
    const { current, crossDoc } = pickAgentsForDoc(awareness, 'foo.md', NOW);
    expect(current).toEqual([{ agentId: 'uuid-A', entry: onFoo }]);
    expect(crossDoc).toEqual([{ agentId: 'uuid-B', entry: onBar }]);
  });

  test('activeDocName === null puts all non-null-currentDoc agents in crossDoc', () => {
    const a = entry({ currentDoc: 'foo.md', ts: NOW });
    const b = entry({ currentDoc: 'bar.md', ts: NOW });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-A': a, 'uuid-B': b } }]);
    const { current, crossDoc } = pickAgentsForDoc(awareness, null, NOW);
    expect(current).toEqual([]);
    // Sort by entry.currentDoc for stable comparison (Biome-safe no-non-null).
    const byDoc = (x: { entry: AgentPresenceEntry }, y: { entry: AgentPresenceEntry }): number =>
      (x.entry.currentDoc ?? '').localeCompare(y.entry.currentDoc ?? '');
    expect([...crossDoc].sort(byDoc)).toEqual(
      [
        { agentId: 'uuid-A', entry: a },
        { agentId: 'uuid-B', entry: b },
      ].sort(byDoc),
    );
  });

  test('currentDoc === null agents are dropped (D8)', () => {
    const ghost = entry({ currentDoc: null, ts: NOW });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-ghost': ghost } }]);
    expect(pickAgentsForDoc(awareness, 'foo.md', NOW)).toEqual({
      current: [],
      crossDoc: [],
    });
  });

  test('stale entries are dropped before bucketing', () => {
    const stale = NOW - AGENT_PRESENCE_STALE_MS - 1;
    const live = entry({ currentDoc: 'foo.md', ts: NOW });
    const old = entry({ currentDoc: 'foo.md', ts: stale });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-live': live, 'uuid-stale': old } }]);
    expect(pickAgentsForDoc(awareness, 'foo.md', NOW)).toEqual({
      current: [{ agentId: 'uuid-live', entry: live }],
      crossDoc: [],
    });
  });

  test('mixed peers aggregate across states map', () => {
    const local = entry({ currentDoc: 'foo.md', ts: NOW });
    const remote = entry({
      currentDoc: 'bar.md',
      ts: NOW,
      displayName: 'Cursor',
      icon: 'cursor',
    });
    const awareness = makeAwareness([
      { agentPresence: { 'uuid-local': local } },
      { agentPresence: { 'uuid-remote': remote } },
    ]);
    const { current, crossDoc } = pickAgentsForDoc(awareness, 'foo.md', NOW);
    expect(current).toEqual([{ agentId: 'uuid-local', entry: local }]);
    expect(crossDoc).toEqual([{ agentId: 'uuid-remote', entry: remote }]);
  });

  test('returns agentId keys paired with entries (O(N) lookup contract)', () => {
    // Regression: pickAgentsForDoc must return {agentId, entry} pairs so
    // downstream consumers don't need a second O(N²) reverse-lookup to
    // recover the key from the entry ref.
    const e = entry({ currentDoc: 'foo.md', ts: NOW });
    const awareness = makeAwareness([{ agentPresence: { 'uuid-specific': e } }]);
    const { current } = pickAgentsForDoc(awareness, 'foo.md', NOW);
    expect(current).toHaveLength(1);
    expect(current[0]?.agentId).toBe('uuid-specific');
    expect(current[0]?.entry).toBe(e);
  });
});

describe('hasAgentPresenceShape', () => {
  test('accepts a real-shaped awareness', () => {
    const real: AgentPresenceAwareness = { getStates: () => new Map() };
    expect(hasAgentPresenceShape(real)).toBe(true);
  });

  test('rejects null and undefined', () => {
    expect(hasAgentPresenceShape(null)).toBe(false);
    expect(hasAgentPresenceShape(undefined)).toBe(false);
  });

  test('rejects objects missing getStates', () => {
    expect(hasAgentPresenceShape({})).toBe(false);
    expect(hasAgentPresenceShape({ states: new Map() })).toBe(false);
  });

  test('rejects objects where getStates is not a function', () => {
    expect(hasAgentPresenceShape({ getStates: 'not-a-function' })).toBe(false);
    expect(hasAgentPresenceShape({ getStates: 42 })).toBe(false);
  });

  test('rejects primitives', () => {
    expect(hasAgentPresenceShape('awareness')).toBe(false);
    expect(hasAgentPresenceShape(42)).toBe(false);
    expect(hasAgentPresenceShape(true)).toBe(false);
  });
});
