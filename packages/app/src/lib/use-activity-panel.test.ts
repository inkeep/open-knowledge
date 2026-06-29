import { describe, expect, test } from 'bun:test';
import type { AgentPresenceEntry } from '@inkeep/open-knowledge-core';
import { computeWritingDocs } from './use-activity-panel';

type AgentPresenceMap = Record<string, AgentPresenceEntry>;

function makeSystemProvider(statesByClientId: Map<number, { agentPresence?: AgentPresenceMap }>) {
  return {
    awareness: {
      getStates: () => statesByClientId,
    },
  };
}

function presence(
  mode: 'idle' | 'writing',
  currentDoc: string | null,
  overrides: Partial<AgentPresenceEntry> = {},
): AgentPresenceEntry {
  return {
    displayName: 'Claude',
    icon: 'claude',
    color: '#d97757',
    currentDoc,
    mode,
    ts: Date.now(),
    ...overrides,
  };
}

describe('computeWritingDocs', () => {
  test('returns empty set when systemProvider is null', () => {
    const result = computeWritingDocs(null, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns empty set when systemProvider has no awareness', () => {
    const result = computeWritingDocs({ awareness: undefined }, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns empty set when awareness.getStates is not a function', () => {
    const result = computeWritingDocs({ awareness: { getStates: 'not a function' } }, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns empty set when agent has no presence entry', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-other': presence('writing', 'notes.md') } }]]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns empty set when agent is idle (not writing)', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-abc': presence('idle', 'notes.md') } }]]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns empty set when writing but currentDoc is null', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-abc': presence('writing', null) } }]]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual([]);
  });

  test('returns the docName when agent is writing to it', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-abc': presence('writing', 'notes.md') } }]]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual(['notes.md']);
  });

  test('matches prefixed connectionId against an entry keyed by the prefixed form', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-abc': presence('writing', 'notes.md') } }]]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual(['notes.md']);
  });

  test('matches raw connectionId by falling back to the prefixed form', () => {
    const provider = makeSystemProvider(
      new Map([[1, { agentPresence: { 'agent-abc': presence('writing', 'notes.md') } }]]),
    );
    const result = computeWritingDocs(provider, 'abc');
    expect([...result]).toEqual(['notes.md']);
  });

  test('aggregates docNames across multiple awareness states if a single agent writes to several files', () => {
    const provider = makeSystemProvider(
      new Map<number, { agentPresence?: AgentPresenceMap }>([
        [1, { agentPresence: { 'agent-abc': presence('writing', 'notes.md') } }],
        [2, { agentPresence: { 'agent-abc': presence('writing', 'specs/foo.md') } }],
      ]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result].sort()).toEqual(['notes.md', 'specs/foo.md']);
  });

  test('ignores other agents in the same awareness state', () => {
    const provider = makeSystemProvider(
      new Map([
        [
          1,
          {
            agentPresence: {
              'agent-abc': presence('writing', 'notes.md'),
              'agent-xyz': presence('writing', 'other.md'),
            },
          },
        ],
      ]),
    );
    const result = computeWritingDocs(provider, 'agent-abc');
    expect([...result]).toEqual(['notes.md']);
  });
});
