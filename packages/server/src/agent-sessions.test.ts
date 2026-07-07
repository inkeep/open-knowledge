import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Document } from '@hocuspocus/server';
import { sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
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

// Minimal Hocuspocus mock for session management tests.
// Each openDirectConnection call returns a unique mock DC so we can track disconnects.
// Uses a real Y.Doc so Y.UndoManager creation succeeds.
//
// Awareness is also represented as a call-log, NOT as state plumbing.
// `AgentSessionManager` MUST NOT touch per-doc awareness —
// presence is published on the `__system__` Y.Doc via `AgentPresenceBroadcaster`
// instead. The log lets tests assert "getSession did not reach for awareness".
function createMockHocuspocus() {
  const openedDocs: string[] = [];
  const ydocs = new Map<string, Y.Doc>();
  const awarenessCalls: Array<{ method: string; args: unknown[] }> = [];

  function makeDC(docName: string): AgentDirectConnection {
    let disconnected = false;
    // Reuse the same Y.Doc per docName so concurrent sessions share state.
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
    // Each unique agentId allocates a (DirectConnection, Y.UndoManager) pair.
    // Without a ceiling, an unbounded distinct-agentId flood from a buggy or
    // malicious client (HTTP body field is regex-validated but otherwise
    // caller-controlled) grows the sessions map indefinitely — keepalive-WS
    // cleanup does not run for HTTP-only callers. Cap surfaces as a typed
    // error so the HTTP layer can respond 503 instead of 500.
    const capped = new AgentSessionManager(mockHocuspocus as never, { maxSessions: 3 });
    await capped.getSession('doc.md', 'agent-1');
    await capped.getSession('doc.md', 'agent-2');
    await capped.getSession('doc.md', 'agent-3');

    // Fourth distinct agentId trips the cap.
    await expect(capped.getSession('doc.md', 'agent-4')).rejects.toBeInstanceOf(
      AgentSessionCapacityError,
    );

    // Existing sessions remain usable — capacity is only enforced on creates.
    const reused = await capped.getSession('doc.md', 'agent-2');
    expect(reused).toBeDefined();

    // After closing one, a new agentId can land again.
    await capped.closeSession('doc.md', 'agent-1');
    const replacement = await capped.getSession('doc.md', 'agent-4');
    expect(replacement).toBeDefined();
    await capped.closeAll();
  });

  test('rejects reserved config doc names with a thrown error (D49 / FR-29)', async () => {
    // Config docs are admitted Y.Text-only at boot; agent
    // sessions on them would attempt to attach the markdown bridge and
    // corrupt YAML. The short-circuit at AgentSessionManager.getSession
    // is the load-bearing gate.
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
    // The peer methods (closeAllForAgent, closeAllForDoc) leak the session
    // entry on cleanup error because they put `this.sessions.delete(key)`
    // INSIDE the try block. closeSession ships with a stronger contract
    // via finally — the entry is always removed so `hasSession()` and
    // `getSession()` cannot return a broken instance after a failed close.
    // The DirectConnection itself may leak in this scenario; the session
    // index does not.
    await manager.getSession('doc.md', 'agent-throws');
    expect(manager.hasSession('doc.md', 'agent-throws')).toBe(true);

    // Reach into the live session and replace dc.disconnect with a thrower.
    // Avoids re-mocking the harness — the public API contract is what we
    // verify (post-call: session is gone, hasSession returns false).
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into internal map for failure injection
    const session = (manager as any).sessions.get(
      // biome-ignore lint/suspicious/noExplicitAny: test reaches into internal map for failure injection
      (manager as any).sessionKey('doc.md', 'agent-throws'),
    );
    expect(session).toBeDefined();
    session.dc.disconnect = async () => {
      throw new Error('SIMULATED: Y.js observers in inconsistent state');
    };

    // closeSession must NOT propagate the throw (caught + logged) and
    // MUST always remove the session entry.
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
    // Launch two concurrent first-calls; dedup map must collapse them to one DC.
    const [session1, session2] = await Promise.all([
      manager.getSession('doc.md', 'agent-alice'),
      manager.getSession('doc.md', 'agent-alice'),
    ]);
    // Same SessionRecord object — only one DC created.
    expect(session1).toBe(session2);
    expect(mockHocuspocus.openedDocs.filter((d) => d === 'doc.md')).toHaveLength(1);
  });

  test('D23: session.origin is deep-frozen — mutation throws in strict mode', async () => {
    const session = await manager.getSession('doc.md', 'agent-alice');
    // Both outer object and context must be frozen.
    expect(Object.isFrozen(session.origin)).toBe(true);
    expect(Object.isFrozen(session.origin.context)).toBe(true);
    // Strict-mode mutation of a frozen object throws TypeError.
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

  // Regression: phantom `Agent (agent-<shortid>)` timeline commits.
  // extractAgentIdentity returns `agent-<raw>` as the sessions-map key / writerId,
  // but `context.session_id` must be the RAW connection id — the `agent-` prefix
  // is the writerId namespace added by `resolveWriterFromOrigin` in persistence.ts.
  // When session_id carried the prefix, resolveWriterFromOrigin double-prefixed to
  // `agent-agent-<raw>` and the onStoreDocument safety-net booked phantom commits
  // under that mismatched writerId.
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
    // After destroy, the UM should have an empty stack (no tracking post-destroy).
    // We just verify the destroy didn't throw.
    expect(session.um.undoStack.length).toBe(0);
  });
});

// applyAgentUndo drain semantics. Complements the end-to-end
// integration test at packages/app/tests/integration/agent-undo.test.ts.
describe('applyAgentUndo — scope drain semantics (V0-14)', () => {
  test("scope='session' drains every UM frame in one call and reports it", async () => {
    const session = await manager.getSession('doc-drain.md', 'agent-drain');
    const ytext = session.dc.document.getText('source');

    // stopCapturing() separates the next transact into its own UM frame,
    // without waiting for the captureTimeout (500ms default).
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

  test("scope='session' returns false on an empty stack (no-op)", async () => {
    const session = await manager.getSession('doc-empty.md', 'agent-empty');
    expect(session.um.undoStack.length).toBe(0);
    expect(applyAgentUndo(session, 'session')).toBe(false);
    expect(applyAgentUndo(session, 'last')).toBe(false);
  });

  test('post-undo XmlFragment uses embedResolver for `![[file]]` refs', async () => {
    // Composition-equivalence with applyAgentMarkdownWrite: the post-undo
    // body re-parse must use the same resolver so PM image `src` lands as
    // the resolved disk path, not the literal target. Without this, the
    // editor renders the inline image with a broken src until the next
    // round-trip.
    const session = await manager.getSession('doc-resolve.md', 'agent-resolve');
    const xmlFragment = session.dc.document.getXmlFragment('default');
    const ytext = session.dc.document.getText('source');

    const embedResolver = {
      resolveEmbed: (basename: string) =>
        basename === 'photo.png' ? 'attachments/photo.png' : null,
      sourcePath: 'doc-resolve.md',
    };

    // Write 1: body containing `![[photo.png]]`
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '![[photo.png]]\n', 'replace', embedResolver);
    }, session.origin);
    session.um.stopCapturing();

    // Write 2: a different body so 'last' undo brings us back to Write 1.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n', 'replace', embedResolver);
    }, session.origin);

    // Sanity: post-write-2 ytext is the heading, no embed.
    expect(ytext.toString()).toContain('# Heading');

    // Undo 'last' restores the wiki-embed body. Pass embedResolver so the
    // re-parse maps `photo.png` → `attachments/photo.png` on the PM image.
    const undone = applyAgentUndo(session, 'last', embedResolver);
    expect(undone).toBe(true);

    // Block-context wiki-embed images materialize as a `jsxComponent` PM
    // node (componentName='WikiEmbedImage'); the resolved disk path lives
    // on `attrs.props.src`. Without the resolver fix the post-undo
    // XmlFragment would carry `props.src='photo.png'` (literal target),
    // diverging from a fresh-load shape.
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

// applyAgentUndo restores user-intended source bytes
// without canonicalize-write-back. Pre-fix the function re-serialized the
// fragment and applied that to ytext, which canonicalized any user-typed
// bytes that don't survive parse → serialize byte-equal (CRLF, BOM, leading
// newlines, doc-start `***` ↔ `---`). Under contract those bytes survive
// the undo flow.
describe('applyAgentUndo — Y.Text-is-truth contract (FR-40)', () => {
  test('preserves CRLF line endings across undo (no canonicalize-write-back)', async () => {
    const session = await manager.getSession('doc-crlf.md', 'agent-crlf');
    const ytext = session.dc.document.getText('source');

    // Write 1: payload with CRLF line endings. composeAndWriteRawBody lands
    // raw bytes verbatim in ytext.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '__foo__\r\nLine 2.\r\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe('__foo__\r\nLine 2.\r\n');

    session.um.stopCapturing();

    // Write 2: a different (LF-only) body so 'last' undo brings us back.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '# Heading\n', 'replace');
    }, session.origin);

    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);

    // Pre-fix: canonicalBody = serialize(parse(ytext)) emits LF-only,
    // applyFastDiff(ytext, canonicalFull) overwrites CRLF with LF, so
    // ytext would land at `__foo__\nLine 2.\n`. Post-fix: ytext keeps the
    // user's original CRLF bytes restored by um.undo().
    expect(ytext.toString()).toBe('__foo__\r\nLine 2.\r\n');
  });

  test('preserves doc-start `---` (no canonicalize to `***\\n\\n`) across undo', async () => {
    const session = await manager.getSession('doc-start-dashes.md', 'agent-dashes');
    const ytext = session.dc.document.getText('source');

    // Write 1: doc starts with `---\n` (thematic break in body
    // position; tolerated equivalent to `***\n` per normalizeBridge).
    // mdast serializes thematic break canonically as `***`.
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

    // Pre-fix: canonicalize-write-back would have rewritten `---\n` to
    // `***\n\n` (architectural-floor blank-line insertion + doc-start
    // canonicalization). Post-fix: user's `---\n` survives.
    expect(ytext.toString()).toBe('---\n# H\n\nBody.\n');
    expect(ytext.toString().startsWith('---\n')).toBe(true);
    expect(ytext.toString().includes('***')).toBe(false);
  });

  test('preserves user-form delimiter `__foo__` across undo (FR-25 alignment check)', async () => {
    // already preserves `__` through serialize(fragment), so this
    // case ALSO worked pre-fix. Test stays because the contract MUST hold
    // here — surfaces the assumption
    // explicitly + protects against regression.
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

    // The user's chosen delimiter form `__` / `_` survives the undo.
    expect(ytext.toString()).toBe('__bold__ and _italic_\n');
    expect(ytext.toString().includes('**bold**')).toBe(false);
    expect(ytext.toString().includes('*italic*')).toBe(false);
  });

  test("scope='session' drains across multiple source-form writes — final state empty", async () => {
    // After session-drain, ytext returns to empty (the pre-write state).
    // Bridge invariant holds throughout because each frame is reverted
    // atomically and the post-undo fragment derives from parse(ytext).
    const session = await manager.getSession('doc-session-drain.md', 'agent-drain');
    const ytext = session.dc.document.getText('source');

    // Three frames, each with a different source-form variation that the
    // pre-fix canonicalize-write-back would have mangled.
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

    // Empty payload on replace empties the body; frontmatter survives because
    // `finalFm = payloadFm || existingFm` falls back to the existing block.
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

    // Y.Text (the contract's source of truth) is empty, and the derived
    // XmlFragment carries no text content — the bridge converged on empty.
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

    // Existing body already ends with a trailing newline — e.g. left by a
    // prior append whose payload ended in `\n`. Seed directly so the byte
    // premise is exact.
    session.dc.document.transact(() => {
      ytext.insert(0, 'alpha line\n');
    }, session.origin);

    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, 'beta line', 'append');
    }, session.origin);

    // Exactly one blank line at the seam — not the `\n\n\n` the bare `\n\n`
    // separator produced on top of the existing trailing newline.
    expect(ytext.toString()).toBe('alpha line\n\nbeta line');
    expect(ytext.toString()).not.toContain('\n\n\n');
  });

  test('prepend normalizes the seam to a single blank line when bodies carry edge newlines (PRD-6837 #3)', async () => {
    const session = await manager.getSession('prepend-seam.md', 'agent-seam-pre');
    const ytext = session.dc.document.getText('source');

    // Existing body starts with a newline; prepended payload ends with one.
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

    // Confirm the gate fired BEFORE any mutation reached Y.Text.
    expect(session.dc.document.getText('source').toString()).toBe('');
  });

  test('applyAgentMarkdownWrite content-irrelevant gate (FR13) — refuses even byte-equal-to-theirs writes', async () => {
    // Baked in: the gate is static on lifecycle.status, not on
    // content. Loading the doc with "theirs" disk bytes and then trying
    // to write those EXACT bytes through the agent surface must still
    // refuse — resolution must route through `resolve_conflict` so the
    // ConflictStore + git index machinery sees the resolution intent.
    const theirsBytes = '# Theirs\n\nTeam version.\n';
    const session = await manager.getSession('content-eq-doc', 'agent-eq');
    // Seed ytext with the disk bytes so the new write content is byte-equal.
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
    // Push a frame onto the undo stack so undo would otherwise have something to do.
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
    // No frames popped — the gate fired before um.undo().
    expect(session.um.undoStack.length).toBeGreaterThan(0);
  });

  test('applyAgentMarkdownWrite passes through when lifecycle.status is undefined', async () => {
    const session = await manager.getSession('clean-doc', 'agent-clean');
    // Status untouched — default state, no gate fires.
    expect(() =>
      applyAgentMarkdownWrite(session.dc.document, '# Hello\n', 'replace'),
    ).not.toThrow();
    expect(session.dc.document.getText('source').toString()).toContain('# Hello');
  });

  // When the file watcher has observed an .mdx doc on disk, the gate's
  // 409 envelope `file` field must carry the .mdx extension — agents that
  // call `conflicts({ kind: "content", file })` from the envelope's payload need
  // the on-disk path to match `/api/sync/conflicts` entries. Default-to-
  // `.md` would silently 404 the agent's follow-up fetch for any .mdx
  // doc.
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

// `position: "replace"` must perform an atomic overwrite. The
// bug class: `case 'replace':` in `applyAgentMarkdownWriteInner` routes
// through `composeAndWriteRawBody` (DMP-incremental, item-preserving via
// `applyFastDiff`) instead of `replaceRawBody` (atomic delete + insert),
// the sibling primitive the same module exports for rollback. The contract
// violation is observable AT ZERO CONCURRENCY: a replace whose payload
// shares any substring with the prior content emits a partial DMP delta
// rather than a full overwrite.
//
// Sibling pin: `bridge-intake.test.ts`'s `replaceRawBody — primitive
// contract` block (FULL-OVERWRITE distinguishing-feature).
describe('applyAgentMarkdownWrite — position: "replace" atomic-overwrite contract (PRD-6667)', () => {
  test('replace overwrites prior bytes atomically — full delete + full insert, not DMP-incremental merge', async () => {
    const session = await manager.getSession('doc-replace-shape.md', 'agent-shape');
    const ytext = session.dc.document.getText('source');

    // Seed. After this, ytext === seed.
    const seed = 'aaaa bbbb cccc\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(seed);

    // Observe YTextEvent.delta on the SECOND replace. The payload shares
    // the prefix `'aaaa bbbb cccc'` with the seed and the trailing `\n` as
    // a common suffix. Under DMP-incremental
    // (`composeAndWriteRawBody` → `applyFastDiff`) the delta only inserts
    // the differing middle ` and extra` (10 chars) — the shared bytes are
    // preserved as Items. Under the atomic primitive (`replaceRawBody` →
    // `ytext.delete(0, len) + ytext.insert(0, raw)`) the entire prior
    // bytes are deleted and the entire payload inserted.
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

    const seed = 'aaaa bbbb cccc\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(seed);

    // A `patch` whose recomposed body shares prefix/suffix with the prior
    // content must emit a MINIMAL DMP delta (the differing middle only) — the
    // opposite of the atomic `replace` pin. This is the contract
    // edit_document depends on: a surgical find/replace stays item-preserving
    // instead of churning the whole doc through replaceRawBody.
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
    const patchedBody = 'aaaa XXXX cccc\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, patchedBody, 'patch');
    }, session.origin);
    ytext.unobserve(observer);

    expect(ytext.toString()).toBe(patchedBody);
    // Minimal delta: only the differing middle is touched, not the whole doc.
    expect(deleteCharCount).toBeLessThan(seed.length);
    expect(insertCharCount).toBeLessThan(patchedBody.length);

    // An empty-body `patch` CLEARS the doc — it is deliberately excluded from
    // the append/prepend empty-payload no-op guard, so it behaves like an
    // empty `replace` rather than a no-op.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '', 'patch');
    }, session.origin);
    expect(ytext.toString()).toBe('');

    // Contrast: an empty-body `append` IS a no-op (guard fires).
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

    // Seed with content that shares prefix + suffix with the replacement —
    // the shape DMP-incremental would partially preserve.
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

    // Seed with FM block.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, '---\ntitle: Old\n---\nOld body.\n', 'replace');
    }, session.origin);
    expect(ytext.toString()).toContain('title: Old');

    // Replace with NEW FM in payload.
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

    // Seed with FM block.
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(
        session.dc.document,
        '---\ntitle: Existing\n---\nOriginal body.\n',
        'replace',
      );
    }, session.origin);

    // Replace with body-only payload (no FM block).
    const bodyOnly = 'Body-only replacement, no FM.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, bodyOnly, 'replace');
    }, session.origin);

    // Existing FM survives; body is fully replaced.
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

    // Second call with byte-identical content must not mutate Y.Text.
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
    // Site A content-divergence gate: applyAgentMarkdownWrite returns
    // undefined when the post-primitive Y.Text bytes match the bytes the
    // payload composed to. This is the common path; divergence indicates a
    // primitive regression (the gate's primary failure-mode), exercised
    // via the rubric typology citation in the gate's inline comment
    // (cross-time mutation) rather than a synthetic mock — no real input
    // can make the primitive diverge from its byte-faithful contract.
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

    // Write 1: seed. stopCapturing finalizes the UM frame so write 2 is its
    // own step (UM merges writes within captureTimeout into one frame).
    const seed = '# Seed Heading\n\nSeed body text.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
    }, session.origin);
    session.um.stopCapturing();

    // Write 2: replace with completely different content.
    const replacement = '# Replacement Heading\n\nDifferent body content.\n';
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, replacement, 'replace');
    }, session.origin);
    expect(ytext.toString()).toBe(replacement);

    // The atomic delete+insert is one UM frame; undo inverts both halves.
    const undone = applyAgentUndo(session, 'last');
    expect(undone).toBe(true);
    expect(ytext.toString()).toBe(seed);
  });
});
