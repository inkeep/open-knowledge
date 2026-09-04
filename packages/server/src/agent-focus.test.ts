import type { Hocuspocus } from '@hocuspocus/server';
import { SYSTEM_DOC_NAME } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { AgentFocusBroadcaster } from './agent-focus.ts';

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

describe('AgentFocusBroadcaster', () => {
  let awareness: ReturnType<typeof makeMockAwareness>;
  let broadcaster: AgentFocusBroadcaster;

  beforeEach(() => {
    awareness = makeMockAwareness();
    broadcaster = new AgentFocusBroadcaster(makeMockHocuspocus(awareness));
  });

  test('setFocus adds a keyed entry to an empty map', () => {
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'foo.md',
      writeKind: 'write',
      ts: 123,
    });
    expect(broadcaster.getFocusMap()).toEqual({
      'claude-1': { agentName: 'Claude', currentDoc: 'foo.md', writeKind: 'write', ts: 123 },
    });
  });

  test('setFocus upserts existing agentId without clobbering other agents', () => {
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'a.md',
      writeKind: 'write',
      ts: 100,
    });
    broadcaster.setFocus('claude-2', {
      agentName: 'Claude-B',
      currentDoc: 'b.md',
      writeKind: 'write',
      ts: 200,
    });
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'a2.md',
      writeKind: 'edit',
      ts: 300,
    });

    const map = broadcaster.getFocusMap();
    expect(Object.keys(map).sort()).toEqual(['claude-1', 'claude-2']);
    expect(map['claude-1'].currentDoc).toBe('a2.md');
    expect(map['claude-1'].writeKind).toBe('edit');
    expect(map['claude-1'].ts).toBe(300);
    expect(map['claude-2'].currentDoc).toBe('b.md');
  });

  test('clearFocus removes only the target agentId', () => {
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'a.md',
      writeKind: 'write',
      ts: 100,
    });
    broadcaster.setFocus('claude-2', {
      agentName: 'Claude-B',
      currentDoc: 'b.md',
      writeKind: 'write',
      ts: 200,
    });

    broadcaster.clearFocus('claude-1');

    const map = broadcaster.getFocusMap();
    expect(Object.keys(map)).toEqual(['claude-2']);
    expect(map['claude-2'].currentDoc).toBe('b.md');
  });

  test('clearFocus on unknown agentId is a no-op', () => {
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'a.md',
      writeKind: 'write',
      ts: 100,
    });
    broadcaster.clearFocus('never-existed');

    expect(broadcaster.getFocusMap()).toEqual({
      'claude-1': { agentName: 'Claude', currentDoc: 'a.md', writeKind: 'write', ts: 100 },
    });
  });

  test('graceful no-op when __system__ document is missing', () => {
    const noopBroadcaster = new AgentFocusBroadcaster(makeMockHocuspocus(null));
    noopBroadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'foo.md',
      writeKind: 'write',
      ts: 123,
    });
    expect(noopBroadcaster.getFocusMap()).toEqual({});
  });

  test('two simulated agents coexist as separate map entries (Path B readiness)', () => {
    broadcaster.setFocus('claude-1', {
      agentName: 'Claude',
      currentDoc: 'a.md',
      writeKind: 'write',
      ts: 100,
    });
    broadcaster.setFocus('claude-2', {
      agentName: 'Claude-B',
      currentDoc: 'b.md',
      writeKind: 'write',
      ts: 150,
    });

    const map = broadcaster.getFocusMap();
    expect(map['claude-1']).toBeDefined();
    expect(map['claude-2']).toBeDefined();
    expect(map['claude-1'].currentDoc).toBe('a.md');
    expect(map['claude-2'].currentDoc).toBe('b.md');
    expect(Object.keys(map).length).toBe(2);
  });

  test('principal-prefixed agentId is filtered at the broadcaster boundary', () => {
    broadcaster.setFocus('principal-deadbeef', {
      agentName: 'Local User',
      currentDoc: 'a.md',
      writeKind: 'edit',
      ts: 100,
    });
    expect(broadcaster.getFocusMap()).toEqual({});

    broadcaster.clearFocus('principal-deadbeef');
    expect(broadcaster.getFocusMap()).toEqual({});

    broadcaster.setFocus('agent-real', {
      agentName: 'Claude',
      currentDoc: 'b.md',
      writeKind: 'write',
      ts: 200,
    });
    expect(Object.keys(broadcaster.getFocusMap())).toEqual(['agent-real']);
  });
});
