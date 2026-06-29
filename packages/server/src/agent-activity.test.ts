import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
  listAgentActivity,
  synthesizeStackItemDiff,
  synthesizeStackItemDiffText,
} from './agent-activity.ts';
import type { AgentSessionManager } from './agent-sessions.ts';

function makeUMPair(_doc: Y.Doc, text: Y.Text) {
  const origin = Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: Object.freeze({ origin: 'agent-write', paired: true as const }),
  });
  const undoOrigin = Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: Object.freeze({ origin: 'agent-undo', paired: true as const }),
  });
  const um = new Y.UndoManager([text], {
    trackedOrigins: new Set([origin]),
    captureTimeout: 0, // each transact = one StackItem
    captureTransaction: (tr: { origin: unknown }) => tr.origin !== undoOrigin,
  });
  return { origin, undoOrigin, um };
}

describe('synthesizeStackItemDiff', () => {
  test('single insert — reports insertion span, no deletions', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const { origin, um } = makeUMPair(doc, text);

    doc.transact(() => {
      text.insert(0, 'hello world');
    }, origin);

    expect(um.undoStack).toHaveLength(1);
    const stackItem = um.undoStack[0];
    const result = synthesizeStackItemDiff(stackItem, text);

    expect(result.insertions).toHaveLength(1);
    expect(result.insertions[0].content).toBe('hello world');
    expect(result.deletions).toHaveLength(0);
    expect(result.after).toBe('hello world');
    expect(result.before).toBe('');
  });

  test('delete produces deletion span and tombstone content is readable', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const { origin, um } = makeUMPair(doc, text);

    doc.transact(() => {
      text.insert(0, 'hello world');
    });

    doc.transact(() => {
      text.delete(0, 5); // delete 'hello'
    }, origin);

    expect(um.undoStack).toHaveLength(1);
    const stackItem = um.undoStack[0];
    const result = synthesizeStackItemDiff(stackItem, text);

    expect(result.deletions.length).toBeGreaterThan(0);
    const deleted = result.deletions.map((d) => d.content).join('');
    expect(deleted).toBe('hello');
    expect(result.insertions).toHaveLength(0);
    expect(result.before).toBe('hello world');
    expect(result.after).toBe(' world');
  });

  test('empty undoStack (no bursts) → synthesize on empty UM returns sensible values', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const dummyStackItem = {
      insertions: Y.createDeleteSet(),
      deletions: Y.createDeleteSet(),
      meta: new Map(),
      // biome-ignore lint/suspicious/noExplicitAny: structural cast for test dummy
    } as any;
    const result = synthesizeStackItemDiff(dummyStackItem, text);
    expect(result.insertions).toHaveLength(0);
    expect(result.deletions).toHaveLength(0);
    expect(result.before).toBe('');
    expect(result.after).toBe('');
  });

  test('multi-item insert merges into correct hunk', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const { origin, um } = makeUMPair(doc, text);

    doc.transact(() => {
      text.insert(0, 'foo');
      text.insert(3, 'bar');
    }, origin);

    expect(um.undoStack).toHaveLength(1);
    const stackItem = um.undoStack[0];
    const result = synthesizeStackItemDiff(stackItem, text);

    const insertedContent = result.insertions.map((i) => i.content).join('');
    expect(insertedContent).toContain('foo');
    expect(insertedContent).toContain('bar');
  });
});

describe('synthesizeStackItemDiffText', () => {
  test('returns empty string when before === after', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const dummyStackItem = {
      insertions: Y.createDeleteSet(),
      deletions: Y.createDeleteSet(),
      meta: new Map(),
      // biome-ignore lint/suspicious/noExplicitAny: structural cast for test dummy
    } as any;
    const result = synthesizeStackItemDiffText(dummyStackItem, text, 'doc.md');
    expect(result).toBe('');
  });

  test('returns unified diff with + lines for an insertion', () => {
    const doc = new Y.Doc();
    const text = doc.getText('source');
    const { origin, um } = makeUMPair(doc, text);

    doc.transact(() => {
      text.insert(0, 'new line\n');
    }, origin);

    const stackItem = um.undoStack[0];
    const diff = synthesizeStackItemDiffText(stackItem, text, 'doc.md');

    expect(diff).toContain('+');
    expect(diff).toContain('new line');
  });
});

function makeSessionManager(sessions: Map<string, unknown>): AgentSessionManager {
  return {
    *sessionsForConnection(connectionId: string) {
      const suffix = `\0${connectionId}`;
      for (const [key, session] of sessions) {
        if (key.endsWith(suffix)) yield session;
      }
    },
    getLiveSession(docName: string, agentId: string) {
      return sessions.get(`${docName}\0${agentId}`);
    },
  } as unknown as AgentSessionManager;
}

describe('listAgentActivity', () => {
  test('returns empty/sessionAlive=false when no sessions for connectionId', () => {
    const manager = makeSessionManager(new Map());
    const result = listAgentActivity(manager, 'agent-abc');
    expect(result.sessionAlive).toBe(false);
    expect(result.agent).toBeNull();
    expect(result.files).toEqual([]);
  });

  test('lists files with bursts for matching connectionId', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const { origin, um } = makeUMPair(doc, ytext);

    doc.transact(() => {
      ytext.insert(0, 'hello\n');
    }, origin);

    expect(um.undoStack).toHaveLength(1);

    const mockDC = {
      document: {
        getText: () => ytext,
        getMap: () => doc.getMap('metadata'),
        getXmlFragment: () => doc.getXmlFragment('default'),
        transact: (fn: () => void, o?: unknown) => doc.transact(fn, o),
        on: doc.on.bind(doc),
        off: doc.off.bind(doc),
        name: 'notes.md',
      },
      disconnect: async () => {},
    };

    const sessions = new Map<string, unknown>();
    sessions.set('notes.md\0agent-abc', {
      docName: 'notes.md',
      agentId: 'agent-abc',
      um,
      dc: mockDC,
      origin,
    });

    const manager = makeSessionManager(sessions);
    const result = listAgentActivity(manager, 'agent-abc');

    expect(result.sessionAlive).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].docName).toBe('notes.md');
    expect(result.files[0].bursts).toHaveLength(1);
  });

  test('orders files by most-recent-burst DESC', () => {
    const docA = new Y.Doc();
    const ytextA = docA.getText('source');
    const pairA = makeUMPair(docA, ytextA);

    const docB = new Y.Doc();
    const ytextB = docB.getText('source');
    const pairB = makeUMPair(docB, ytextB);

    docA.transact(() => {
      ytextA.insert(0, 'aaa');
    }, pairA.origin);

    const tsBefore = Date.now();
    docB.transact(() => {
      ytextB.insert(0, 'bbb');
    }, pairB.origin);

    if (pairA.um.undoStack[0].meta instanceof Map) {
      pairA.um.undoStack[0].meta.set('time', tsBefore - 1000);
    }
    if (pairB.um.undoStack[0].meta instanceof Map) {
      pairB.um.undoStack[0].meta.set('time', tsBefore + 1000);
    }

    function makeMockDC(docRef: Y.Doc, docName: string) {
      return {
        document: {
          getText: () => docRef.getText('source'),
          getMap: () => docRef.getMap('metadata'),
          getXmlFragment: () => docRef.getXmlFragment('default'),
          transact: (fn: () => void, o?: unknown) => docRef.transact(fn, o),
          on: docRef.on.bind(docRef),
          off: docRef.off.bind(docRef),
          name: docName,
        },
        disconnect: async () => {},
      };
    }

    const sessions = new Map<string, unknown>();
    sessions.set('file-a.md\0agent-abc', {
      docName: 'file-a.md',
      agentId: 'agent-abc',
      um: pairA.um,
      dc: makeMockDC(docA, 'file-a.md'),
      origin: pairA.origin,
    });
    sessions.set('file-b.md\0agent-abc', {
      docName: 'file-b.md',
      agentId: 'agent-abc',
      um: pairB.um,
      dc: makeMockDC(docB, 'file-b.md'),
      origin: pairB.origin,
    });

    const manager = makeSessionManager(sessions);
    const result = listAgentActivity(manager, 'agent-abc');

    expect(result.files[0].docName).toBe('file-b.md');
    expect(result.files[1].docName).toBe('file-a.md');
  });

  test('bursts are ordered by stackIndex DESC (newest first)', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const { origin, um } = makeUMPair(doc, ytext);

    doc.transact(() => {
      ytext.insert(0, 'first\n');
    }, origin);
    doc.transact(() => {
      ytext.insert(ytext.length, 'second\n');
    }, origin);
    doc.transact(() => {
      ytext.insert(ytext.length, 'third\n');
    }, origin);

    expect(um.undoStack).toHaveLength(3);

    const mockDC = {
      document: {
        getText: () => ytext,
        getMap: () => doc.getMap('metadata'),
        getXmlFragment: () => doc.getXmlFragment('default'),
        transact: (fn: () => void, o?: unknown) => doc.transact(fn, o),
        on: doc.on.bind(doc),
        off: doc.off.bind(doc),
        name: 'notes.md',
      },
      disconnect: async () => {},
    };

    const sessions = new Map<string, unknown>();
    sessions.set('notes.md\0agent-xyz', {
      docName: 'notes.md',
      agentId: 'agent-xyz',
      um,
      dc: mockDC,
      origin,
    });

    const manager = makeSessionManager(sessions);
    const result = listAgentActivity(manager, 'agent-xyz');

    const bursts = result.files[0].bursts;
    expect(bursts).toHaveLength(3);
    expect(bursts[0].stackIndex).toBeGreaterThan(bursts[1].stackIndex);
    expect(bursts[1].stackIndex).toBeGreaterThan(bursts[2].stackIndex);
  });
});
