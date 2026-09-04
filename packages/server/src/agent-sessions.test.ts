import type { Document } from '@hocuspocus/server';
import { sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  type AgentDirectConnection,
  AgentSessionCapacityError,
  AgentSessionManager,
  applyAgentMarkdownWrite,
  applyAgentUndo,
} from './agent-sessions.ts';
import { DocInConflictError } from './conflict-errors.ts';
import { _resetDocExtensionsForTests, registerDocExtension } from './doc-extensions.ts';

function createMockHocuspocus() {
  const openedDocs: string[] = [];
  const ydocs = new Map<string, Y.Doc>();
  const awarenessCalls: Array<{ method: string; args: unknown[] }> = [];

  function makeDC(docName: string): AgentDirectConnection {
    let disconnected = false;
    let ydoc = ydocs.get(docName);
    if (!ydoc) {
      ydoc = new Y.Doc();
      ydocs.set(docName, ydoc);
    }
    const awareness = {
      setLocalState(...args: unknown[]) {
        awarenessCalls.push({ method: 'setLocalState', args });
      },
      setLocalStateField(...args: unknown[]) {
        awarenessCalls.push({ method: 'setLocalStateField', args });
      },
    };
    const doc = {
      name: docName,
      awareness,
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
    openedDocs,
    awarenessCalls,
    openDirectConnection: async (docName: string): Promise<AgentDirectConnection> => {
      openedDocs.push(docName);
      return makeDC(docName);
    },
  };
}

let mockHocuspocus: ReturnType<typeof createMockHocuspocus>;
let manager: AgentSessionManager;

beforeEach(() => {
  mockHocuspocus = createMockHocuspocus();
  manager = new AgentSessionManager(mockHocuspocus as never);
});

afterEach(async () => {
  await manager.closeAll();
});

describe('getSession — composite key (docName + agentId)', () => {
  test('creates a session on first call', async () => {
    await manager.getSession('doc.md', 'agent-alice');
    expect(manager.hasSession('doc.md', 'agent-alice')).toBe(true);
  });

  test('returns the same DC on repeated calls (idempotent)', async () => {
    const dc1 = await manager.getSession('doc.md', 'agent-alice');
    const dc2 = await manager.getSession('doc.md', 'agent-alice');
    expect(dc1).toBe(dc2);
    expect(mockHocuspocus.openedDocs.filter((d) => d === 'doc.md')).toHaveLength(1);
  });

  test('creates separate sessions for different agents on the same doc', async () => {
    const dc1 = await manager.getSession('doc.md', 'agent-alice');
    const dc2 = await manager.getSession('doc.md', 'agent-bob');
    expect(dc1).not.toBe(dc2);
    expect(manager.hasSession('doc.md', 'agent-alice')).toBe(true);
    expect(manager.hasSession('doc.md', 'agent-bob')).toBe(true);
  });

  test('creates separate sessions for the same agent on different docs', async () => {
    await manager.getSession('doc-a.md', 'agent-alice');
    await manager.getSession('doc-b.md', 'agent-alice');
    expect(manager.hasSession('doc-a.md', 'agent-alice')).toBe(true);
    expect(manager.hasSession('doc-b.md', 'agent-alice')).toBe(true);
  });

  test('default agentId is claude-1', async () => {
    await manager.getSession('doc.md');
    expect(manager.hasSession('doc.md', 'claude-1')).toBe(true);
  });

  test('does not touch per-doc awareness (presence lives on __system__ via AgentPresenceBroadcaster)', async () => {
    await manager.getSession('doc.md', 'agent-alice', {
      displayName: 'Alice',
      colorSeed: 'seed',
      clientName: 'claude-code',
    });
    await manager.closeSession('doc.md', 'agent-alice');
    expect(mockHocuspocus.awarenessCalls).toEqual([]);
  });

  test('rejects reserved system doc names with a thrown error (D49)', async () => {
    await expect(manager.getSession('__system__', 'agent-alice')).rejects.toThrow(/reserved doc/i);
  });

  test('throws AgentSessionCapacityError once total live sessions hit the cap (DoS bound)', async () => {
    const capped = new AgentSessionManager(mockHocuspocus as never, { maxSessions: 3 });
    await capped.getSession('doc.md', 'agent-1');
    await capped.getSession('doc.md', 'agent-2');
    await capped.getSession('doc.md', 'agent-3');

    await expect(capped.getSession('doc.md', 'agent-4')).rejects.toBeInstanceOf(
      AgentSessionCapacityError,
    );

    const reused = await capped.getSession('doc.md', 'agent-2');
    expect(reused).toBeDefined();

    await capped.closeSession('doc.md', 'agent-1');
    const replacement = await capped.getSession('doc.md', 'agent-4');
    expect(replacement).toBeDefined();
    await capped.closeAll();
  });

  test('rejects reserved config doc names with a thrown error (D49 / FR-29)', async () => {
    await expect(manager.getSession('__config__/project', 'agent-alice')).rejects.toThrow(
      /reserved doc/i,
    );
    await expect(manager.getSession('__local__/project', 'agent-alice')).rejects.toThrow(
      /reserved doc/i,
    );
    await expect(manager.getSession('__user__/config.yml', 'agent-alice')).rejects.toThrow(
      /reserved doc/i,
    );
  });
});

describe('closeSession', () => {
  test('removes only the targeted (docName, agentId) session', async () => {
    await manager.getSession('doc.md', 'agent-alice');
    await manager.getSession('doc.md', 'agent-bob');
    await manager.closeSession('doc.md', 'agent-alice');
    expect(manager.hasSession('doc.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc.md', 'agent-bob')).toBe(true);
  });

  test('is a no-op for non-existent sessions', async () => {
    await expect(manager.closeSession('doc.md', 'agent-nobody')).resolves.toBeUndefined();
  });

  test('always deletes the session entry, even when disconnect throws', async () => {
    await manager.getSession('doc.md', 'agent-throws');
    expect(manager.hasSession('doc.md', 'agent-throws')).toBe(true);

    // biome-ignore lint/suspicious/noExplicitAny: test reaches into internal map for failure injection
    const session = (manager as any).sessions.get(
      // biome-ignore lint/suspicious/noExplicitAny: test reaches into internal map for failure injection
      (manager as any).sessionKey('doc.md', 'agent-throws'),
    );
    expect(session).toBeDefined();
    session.dc.disconnect = async () => {
      throw new Error('SIMULATED: Y.js observers in inconsistent state');
    };

    await expect(manager.closeSession('doc.md', 'agent-throws')).resolves.toBeUndefined();
    expect(manager.hasSession('doc.md', 'agent-throws')).toBe(false);
  });
});

describe('closeAllForDoc', () => {
  test('closes all agents for a document, leaving others intact', async () => {
    await manager.getSession('doc-a.md', 'agent-alice');
    await manager.getSession('doc-a.md', 'agent-bob');
    await manager.getSession('doc-b.md', 'agent-alice');

    await manager.closeAllForDoc('doc-a.md');

    expect(manager.hasSession('doc-a.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc-a.md', 'agent-bob')).toBe(false);
    expect(manager.hasSession('doc-b.md', 'agent-alice')).toBe(true);
  });

  test('is a no-op when no sessions exist for doc', async () => {
    await expect(manager.closeAllForDoc('nonexistent.md')).resolves.toBeUndefined();
  });
});

describe('closeAllForAgent', () => {
  test('closes all docs for an agent, leaving others intact', async () => {
    await manager.getSession('doc-a.md', 'agent-alice');
    await manager.getSession('doc-b.md', 'agent-alice');
    await manager.getSession('doc-a.md', 'agent-bob');

    await manager.closeAllForAgent('agent-alice');

    expect(manager.hasSession('doc-a.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc-b.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc-a.md', 'agent-bob')).toBe(true);
  });
});

describe('closeAll', () => {
  test('without docName: closes every session', async () => {
    await manager.getSession('doc-a.md', 'agent-alice');
    await manager.getSession('doc-b.md', 'agent-bob');

    await manager.closeAll();

    expect(manager.hasSession('doc-a.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc-b.md', 'agent-bob')).toBe(false);
  });

  test('with docName: delegates to closeAllForDoc', async () => {
    await manager.getSession('doc-a.md', 'agent-alice');
    await manager.getSession('doc-b.md', 'agent-alice');

    await manager.closeAll('doc-a.md');

    expect(manager.hasSession('doc-a.md', 'agent-alice')).toBe(false);
    expect(manager.hasSession('doc-b.md', 'agent-alice')).toBe(true);
  });
});

describe('per-session origin — US-007', () => {
  test('D30: concurrent getSession calls produce exactly one openDirectConnection call', async () => {
    const [session1, session2] = await Promise.all([
      manager.getSession('doc.md', 'agent-alice'),
      manager.getSession('doc.md', 'agent-alice'),
    ]);
    expect(session1).toBe(session2);
    expect(mockHocuspocus.openedDocs.filter((d) => d === 'doc.md')).toHaveLength(1);
  });

  test('D23: session.origin is deep-frozen — mutation throws in strict mode', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(Object.isFrozen(session.origin)).toBe(true);
    expect(Object.isFrozen(session.origin.context)).toBe(true);
    expect(() => {
      (session.origin as Record<string, unknown>).source = 'remote';
    }).toThrow(TypeError);
  });

  test('object-identity-unique: origins from different sessions are not ===', async () => {
    const sessionA = await manager.getSession('doc.md', 'agent-alice');
    const sessionB = await manager.getSession('doc.md', 'agent-bob');
    expect(sessionA.origin).not.toBe(sessionB.origin);
  });

  test('SessionRecord carries correct agentId and docName', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(session.agentId).toBe('agent-alice');
    expect(session.docName).toBe('doc.md');
  });

  test('session_id in origin context is RAW (unprefixed) even when agentId is prefixed', async () => {
    const session = await manager.getSession('doc.md', 'agent-85aabbcc-1234');
    expect(session.agentId).toBe('agent-85aabbcc-1234');
    expect(session.origin.context.session_id).toBe('85aabbcc-1234');
    expect(session.undoOrigin.context.session_id).toBe('85aabbcc-1234');
  });

  test('session_id in origin context is unchanged when agentId has no prefix', async () => {
    const session = await manager.getSession('doc.md', 'claude-1');
    expect(session.agentId).toBe('claude-1');
    expect(session.origin.context.session_id).toBe('claude-1');
    expect(session.undoOrigin.context.session_id).toBe('claude-1');
  });
});

describe('per-session UndoManager — US-008', () => {
  test('session.um exists and is a Y.UndoManager', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(session.um).toBeInstanceOf(Y.UndoManager);
  });

  test('session.undoOrigin is deep-frozen', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(Object.isFrozen(session.undoOrigin)).toBe(true);
    expect(Object.isFrozen(session.undoOrigin.context)).toBe(true);
  });

  test('um.trackedOrigins contains session.origin by identity', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(session.um.trackedOrigins.has(session.origin)).toBe(true);
  });

  test('um.trackedOrigins does NOT contain undoOrigin', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    expect(session.um.trackedOrigins.has(session.undoOrigin)).toBe(false);
  });

  test('different sessions have independent UndoManagers (not ===)', async () => {
    const sessionA = await manager.getSession('doc.md', 'agent-alice');
    const sessionB = await manager.getSession('doc.md', 'agent-bob');
    expect(sessionA.um).not.toBe(sessionB.um);
  });

  test('um.destroy() is called on closeSession — subsequent doc transact does not push to undoStack', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    await manager.closeSession('doc.md', 'agent-alice');
    expect(session.um.undoStack.length).toBe(0);
  });
});

describe('applyAgentUndo — scope drain semantics (V0-14)', () => {
  test("scope='session' drains every UM frame in one call and reports it", async () => {
    const session = await manager.getSession('doc-drain.md', 'agent-drain');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => ytext.insert(0, 'a'), session.origin);
    session.um.stopCapturing();
    session.dc.document.transact(() => ytext.insert(0, 'b'), session.origin);
    session.um.stopCapturing();
    session.dc.document.transact(() => ytext.insert(0, 'c'), session.origin);

    expect(session.um.undoStack.length).toBe(3);

    const undone = applyAgentUndo(session, 'session');
    expect(undone).toBe(true);
    expect(session.um.undoStack.length).toBe(0);

    const undoneAgain = applyAgentUndo(session, 'session');
    expect(undoneAgain).toBe(false);
  });

  test("scope='last' pops exactly one frame", async () => {
    const session = await manager.getSession('doc-last.md', 'agent-last');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => ytext.insert(0, 'x'), session.origin);
    session.um.stopCapturing();
    session.dc.document.transact(() => ytext.insert(0, 'y'), session.origin);

    expect(session.um.undoStack.length).toBe(2);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);
    expect(session.um.undoStack.length).toBe(1);
  });

  test("scope='count' pops the N newest frames and keeps the rest", async () => {
    const session = await manager.getSession('doc-count.md', 'agent-count');
    const ytext = session.dc.document.getText('source');

    for (const ch of ['a', 'b', 'c', 'd']) {
      session.dc.document.transact(() => ytext.insert(0, ch), session.origin);
      session.um.stopCapturing();
    }
    expect(session.um.undoStack.length).toBe(4);

    const undone = applyAgentUndo(session, 'count', undefined, 2);
    expect(undone).toBe(true);
    expect(session.um.undoStack.length).toBe(2);
  });

  test("scope='count' clamps an over-large count to a full drain", async () => {
    const session = await manager.getSession('doc-count-clamp.md', 'agent-count-clamp');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => ytext.insert(0, 'x'), session.origin);
    session.um.stopCapturing();
    session.dc.document.transact(() => ytext.insert(0, 'y'), session.origin);
    expect(session.um.undoStack.length).toBe(2);

    expect(applyAgentUndo(session, 'count', undefined, 99)).toBe(true);
    expect(session.um.undoStack.length).toBe(0);
  });

  test("scope='count' with a non-positive count is a no-op", async () => {
    const session = await manager.getSession('doc-count-zero.md', 'agent-count-zero');
    const ytext = session.dc.document.getText('source');
    session.dc.document.transact(() => ytext.insert(0, 'z'), session.origin);
    expect(session.um.undoStack.length).toBe(1);

    expect(applyAgentUndo(session, 'count', undefined, 0)).toBe(false);
    expect(session.um.undoStack.length).toBe(1);
  });

  test("scope='session' returns false on an empty stack (no-op)", async () => {
    const session = await manager.getSession('doc-empty.md', 'agent-empty');
    expect(session.um.undoStack.length).toBe(0);
    expect(applyAgentUndo(session, 'session')).toBe(false);
    expect(applyAgentUndo(session, 'last')).toBe(false);
  });

  test('post-undo XmlFragment uses embedResolver for `![[file]]` refs', async () => {
    const session = await manager.getSession('doc-resolve.md', 'agent-resolve');
    const xmlFragment = session.dc.document.getXmlFragment('default');
    const ytext = session.dc.document.getText('source');

    const embedResolver = {
      resolveEmbed: (basename: string) =>
        basename === 'photo.png' ? 'attachments/photo.png' : null,
      sourcePath: 'doc-resolve.md',
    };

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '![[photo.png]]\n', 'replace', embedResolver);
    }, session.origin);
    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n', 'replace', embedResolver);
    }, session.origin);

    expect(ytext.toString()).toContain('# Heading');

    const undone = applyAgentUndo(session, 'last', embedResolver);
    expect(undone).toBe(true);

    const schema = getSchema(sharedExtensions);
    const pmJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const node = pmJson.content?.[0] as
      | { type?: string; attrs?: { componentName?: string; props?: Record<string, unknown> } }
      | undefined;
    expect(node?.type).toBe('jsxComponent');
    expect(node?.attrs?.componentName).toBe('WikiEmbedImage');
    expect(node?.attrs?.props?.src).toBe('/attachments/photo.png');
    expect(node?.attrs?.props?.target).toBe('photo.png');
  });
});

describe('applyAgentUndo — Y.Text-is-truth contract (FR-40)', () => {
  test('preserves CRLF line endings across undo (no canonicalize-write-back)', async () => {
    const session = await manager.getSession('doc-crlf.md', 'agent-crlf');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '__foo__\r\nLine 2.\r\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe('__foo__\r\nLine 2.\r\n');

    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n', 'replace');
    }, session.origin);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);

    expect(ytext.toString()).toBe('__foo__\r\nLine 2.\r\n');
  });

  test('preserves doc-start `---` (no canonicalize to `***\\n\\n`) across undo', async () => {
    const session = await manager.getSession('doc-start-dashes.md', 'agent-dashes');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '---\n# H\n\nBody.\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe('---\n# H\n\nBody.\n');

    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Other\n', 'replace');
    }, session.origin);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);

    expect(ytext.toString()).toBe('---\n# H\n\nBody.\n');
    expect(ytext.toString().startsWith('---\n')).toBe(true);
    expect(ytext.toString().includes('***')).toBe(false);
  });

  test('preserves user-form delimiter `__foo__` across undo (FR-25 alignment check)', async () => {
    const session = await manager.getSession('doc-delimiter.md', 'agent-delim');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '__bold__ and _italic_\n', 'replace');
    }, session.origin);
    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n', 'replace');
    }, session.origin);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);

    expect(ytext.toString()).toBe('__bold__ and _italic_\n');
    expect(ytext.toString().includes('**bold**')).toBe(false);
    expect(ytext.toString().includes('*italic*')).toBe(false);
  });

  test("scope='session' drains across multiple source-form writes — final state empty", async () => {
    const session = await manager.getSession('doc-session-drain.md', 'agent-drain');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '__a__\r\n', 'replace');
    }, session.origin);
    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '---\n# B\n', 'replace');
    }, session.origin);
    session.um.stopCapturing();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '## H ##\nC\n', 'replace');
    }, session.origin);

    expect(session.um.undoStack.length).toBe(3);

    const undone = applyAgentUndo(session, 'session');
    expect(undone).toBe(true);
    expect(session.um.undoStack.length).toBe(0);
    expect(ytext.toString()).toBe('');
  });
});

describe('empty / whitespace content writes (PRD-6835)', () => {
  test('replace with empty markdown clears the body and preserves frontmatter', async () => {
    const session = await manager.getSession('clear-me.md', 'agent-clear');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(
        session.dc.document,
        '---\ntitle: Keep Me\ntags: [a, b]\n---\n# Heading\n\nbody text\n',
        'replace',
      );
    }, session.origin);
    expect(ytext.toString()).toContain('# Heading');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'replace');
    }, session.origin);

    const after = ytext.toString();
    expect(after).toContain('title: Keep Me');
    expect(after).toContain('tags: [a, b]');
    expect(after).not.toContain('# Heading');
    expect(after).not.toContain('body text');
    expect(stripFrontmatter(after).body.trim()).toBe('');
  });

  test('replace with empty markdown on a frontmatter-less doc clears to empty (bridge converges)', async () => {
    const session = await manager.getSession('clear-plain.md', 'agent-clear-plain');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Hello\n\nworld\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toContain('# Hello');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'replace');
    }, session.origin);

    expect(ytext.toString()).toBe('');
    const schema = getSchema(sharedExtensions);
    const node = yXmlFragmentToProseMirrorRootNode(
      session.dc.document.getXmlFragment('default'),
      schema,
    );
    expect(node.textContent).toBe('');
  });

  test('append with empty markdown is a no-op (no \\n\\n injection, byte-unchanged)', async () => {
    const session = await manager.getSession('append-empty.md', 'agent-append');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha\n', 'replace');
    }, session.origin);
    const before = ytext.toString();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'append');
    }, session.origin);

    expect(ytext.toString()).toBe(before);
  });

  test('prepend with empty markdown is a no-op (byte-unchanged)', async () => {
    const session = await manager.getSession('prepend-empty.md', 'agent-prepend');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha\n', 'replace');
    }, session.origin);
    const before = ytext.toString();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'prepend');
    }, session.origin);

    expect(ytext.toString()).toBe(before);
  });

  test('frontmatter-only append is a no-op (payload FM dropped, body empty)', async () => {
    const session = await manager.getSession('append-fm-only.md', 'agent-append-fm');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha\n', 'replace');
    }, session.origin);
    const before = ytext.toString();

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '---\nx: 1\n---\n', 'append');
    }, session.origin);

    expect(ytext.toString()).toBe(before);
  });

  test('append normalizes the seam to a single blank line when the body ends with a newline (PRD-6837 #3)', async () => {
    const session = await manager.getSession('append-seam.md', 'agent-seam');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      ytext.insert(0, 'alpha line\n');
    }, session.origin);

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, 'beta line', 'append');
    }, session.origin);

    expect(ytext.toString()).toBe('alpha line\n\nbeta line');
    expect(ytext.toString()).not.toContain('\n\n\n');
  });

  test('prepend normalizes the seam to a single blank line when bodies carry edge newlines (PRD-6837 #3)', async () => {
    const session = await manager.getSession('prepend-seam.md', 'agent-seam-pre');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      ytext.insert(0, '\nalpha line');
    }, session.origin);

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, 'beta line\n', 'prepend');
    }, session.origin);

    expect(ytext.toString()).toBe('beta line\n\nalpha line');
    expect(ytext.toString()).not.toContain('\n\n\n');
  });
});

describe('conflict-aware write gate (FR9 a, d)', () => {
  test('applyAgentMarkdownWrite throws DocInConflictError when lifecycle.status="conflict"', async () => {
    const session = await manager.getSession('conflicted-doc', 'agent-gate');
    session.dc.document.getMap('lifecycle').set('status', 'conflict');

    let caught: unknown;
    try {
      applyAgentMarkdownWrite(session.dc.document, 'new content\n', 'replace');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DocInConflictError).toBe(true);
    if (caught instanceof DocInConflictError) {
      expect(caught.file).toBe('conflicted-doc.md');
    }

    expect(session.dc.document.getText('source').toString()).toBe('');
  });

  test('applyAgentMarkdownWrite content-irrelevant gate (FR13) — refuses even byte-equal-to-theirs writes', async () => {
    const theirsBytes = '# Theirs\n\nTeam version.\n';
    const session = await manager.getSession('content-eq-doc', 'agent-eq');
    session.dc.document.transact(() => {
      session.dc.document.getText('source').insert(0, theirsBytes);
    });
    session.dc.document.getMap('lifecycle').set('status', 'conflict');

    let caught: unknown;
    try {
      applyAgentMarkdownWrite(session.dc.document, theirsBytes, 'replace');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DocInConflictError).toBe(true);
  });

  test('applyAgentUndo throws DocInConflictError when lifecycle.status="conflict"', async () => {
    const session = await manager.getSession('conflicted-undo', 'agent-undo-gate');
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Pre-conflict\n', 'replace');
    }, session.origin);
    session.um.stopCapturing();
    expect(session.um.undoStack.length).toBeGreaterThan(0);

    session.dc.document.getMap('lifecycle').set('status', 'conflict');

    let caught: unknown;
    try {
      applyAgentUndo(session, 'last');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DocInConflictError).toBe(true);
    if (caught instanceof DocInConflictError) {
      expect(caught.file).toBe('conflicted-undo.md');
    }
    expect(session.um.undoStack.length).toBeGreaterThan(0);
  });

  test('applyAgentMarkdownWrite passes through when lifecycle.status is undefined', async () => {
    const session = await manager.getSession('clean-doc', 'agent-clean');
    expect(() =>
      applyAgentMarkdownWrite(session.dc.document, '# Hello\n', 'replace'),
    ).not.toThrow();
    expect(session.dc.document.getText('source').toString()).toContain('# Hello');
  });

  test('applyAgentMarkdownWrite envelope file carries .mdx when getDocExtension knows', async () => {
    _resetDocExtensionsForTests();
    registerDocExtension('mdx-doc', '.mdx');

    const session = await manager.getSession('mdx-doc', 'agent-mdx');
    session.dc.document.getMap('lifecycle').set('status', 'conflict');

    let caught: unknown;
    try {
      applyAgentMarkdownWrite(session.dc.document, 'whatever\n', 'replace');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof DocInConflictError).toBe(true);
    if (caught instanceof DocInConflictError) {
      expect(caught.file).toBe('mdx-doc.mdx');
    }

    _resetDocExtensionsForTests();
  });
});

describe('applyAgentMarkdownWrite — position: "replace" atomic-overwrite contract (PRD-6667)', () => {
  test('replace overwrites prior bytes atomically — full delete + full insert, not DMP-incremental merge', async () => {
    const session = await manager.getSession('doc-replace-shape.md', 'agent-shape');
    const ytext = session.dc.document.getText('source');

    const seed = 'aaaa bbbb cccc\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(seed);

    let insertCharCount = 0;
    let deleteCharCount = 0;
    const observer = (event: Y.YTextEvent): void => {
      for (const change of event.changes.delta) {
        if (change.insert && typeof change.insert === 'string') {
          insertCharCount += change.insert.length;
        }
        if (change.delete) deleteCharCount += change.delete;
      }
    };
    ytext.observe(observer);

    const replacePayload = 'aaaa bbbb cccc and extra\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, replacePayload, 'replace');
    }, session.origin);
    ytext.unobserve(observer);

    expect(insertCharCount).toBe(replacePayload.length);
    expect(deleteCharCount).toBe(seed.length);
  });

  test("position 'patch' (edit_document) writes incrementally and clears on empty body (not a no-op)", async () => {
    const session = await manager.getSession('doc-patch-incremental.md', 'agent-patch-inc');
    const ytext = session.dc.document.getText('source');

    const seed = 'head line\n\naaaa bbbb cccc\n\ntail line\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(seed);

    let insertCharCount = 0;
    let deleteCharCount = 0;
    const observer = (event: Y.YTextEvent): void => {
      for (const change of event.changes.delta) {
        if (change.insert && typeof change.insert === 'string') {
          insertCharCount += change.insert.length;
        }
        if (change.delete) deleteCharCount += change.delete;
      }
    };
    ytext.observe(observer);
    const patchedBody = 'head line\n\naaaa XXXX cccc\n\ntail line\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, patchedBody, 'patch');
    }, session.origin);
    ytext.unobserve(observer);

    expect(ytext.toString()).toBe(patchedBody);
    expect(deleteCharCount).toBeLessThan(seed.length);
    expect(insertCharCount).toBeLessThan(patchedBody.length);
    expect(deleteCharCount).toBeLessThanOrEqual('aaaa bbbb cccc\n'.length);
    expect(insertCharCount).toBeLessThanOrEqual('aaaa XXXX cccc\n'.length);

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'patch');
    }, session.origin);
    expect(ytext.toString()).toBe('');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, 'restored\n', 'replace');
    }, session.origin);
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'append');
    }, session.origin);
    expect(ytext.toString()).toBe('restored\n');
  });

  test('single-writer replace lands payload bytes verbatim in Y.Text', async () => {
    const session = await manager.getSession('doc-replace-verbatim.md', 'agent-verbatim');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n\nOld body text.\n', 'replace');
    }, session.origin);

    const payload = '# Heading\n\nCompletely different body text.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, payload, 'replace');
    }, session.origin);

    expect(ytext.toString()).toBe(payload);
  });

  test('replace with FM in payload supersedes existing FM', async () => {
    const session = await manager.getSession('doc-fm-payload.md', 'agent-fm-payload');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '---\ntitle: Old\n---\nOld body.\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toContain('title: Old');

    const payload = '---\ntitle: New\n---\nNew body.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, payload, 'replace');
    }, session.origin);

    expect(ytext.toString()).toBe(payload);
    expect(ytext.toString()).toContain('title: New');
    expect(ytext.toString()).not.toContain('title: Old');
  });

  test('replace with body-only payload preserves existing FM', async () => {
    const session = await manager.getSession('doc-fm-preserve.md', 'agent-fm-preserve');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(
        session.dc.document,
        '---\ntitle: Existing\n---\nOriginal body.\n',
        'replace',
      );
    }, session.origin);

    const bodyOnly = 'Body-only replacement, no FM.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, bodyOnly, 'replace');
    }, session.origin);

    expect(ytext.toString()).toContain('title: Existing');
    expect(ytext.toString()).toContain('Body-only replacement, no FM.');
    expect(ytext.toString()).not.toContain('Original body.');
  });

  test('replace with content identical to current state is a no-op (idempotent)', async () => {
    const session = await manager.getSession('doc-idempotent.md', 'agent-idempotent');
    const ytext = session.dc.document.getText('source');

    const content = '# Heading\n\nBody paragraph.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, content, 'replace');
    }, session.origin);

    let mutationCount = 0;
    const observer = (): void => {
      mutationCount++;
    };
    ytext.observe(observer);

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, content, 'replace');
    }, session.origin);
    ytext.unobserve(observer);

    expect(mutationCount).toBe(0);
    expect(ytext.toString()).toBe(content);
  });

  test('returns undefined when ytext matches intent (Site A negative path)', async () => {
    const session = await manager.getSession('doc-gate-negative.md', 'agent-gate-negative');
    let divergence: unknown;
    session.dc.document.transact(() => {
      divergence = applyAgentMarkdownWrite(session.dc.document, '# Heading\n\nBody.\n', 'replace');
    }, session.origin);
    expect(divergence).toBeUndefined();
  });

  test('session.um.undo() after a replace restores prior bytes (one atomic UM frame)', async () => {
    const session = await manager.getSession('doc-replace-undo.md', 'agent-replace-undo');
    const ytext = session.dc.document.getText('source');

    const seed = '# Seed Heading\n\nSeed body text.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    session.um.stopCapturing();

    const replacement = '# Replacement Heading\n\nDifferent body content.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, replacement, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(replacement);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);
    expect(ytext.toString()).toBe(seed);
  });
});
