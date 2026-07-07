/**
 * `applyAgentMarkdownWrite(..., 'replace')` under CRDT-level convergence.
 *
 * Deterministic two-Y.Doc + manual `Y.encodeStateAsUpdate` exchange —
 * after the real-Hocuspocus
 * integration harness was shown to consistently sequence edits through
 * Observer A before the agent's HTTP fire, masking the race. Two-Y.Doc
 * lets us control "in-flight peer ops" timing deterministically.
 *
 * Two contracts:
 *
 *  1. Single-writer (peer fully synced before replace fires) — converged
 *     Y.Text equals the agent's payload byte-for-byte. The atomic
 *     primitive's contract at the layer where it executes.
 *
 *  2. Concurrent peer typing (peer's ops in flight when replace fires) —
 *     the agent's payload survives as a contiguous substring in the
 *     converged doc. This is the distinguishing observable property of
 *     the atomic primitive (`replaceRawBody`): all prior items are
 *     tombstoned by the full delete, and the agent's content lands as a
 *     contiguous block of fresh items. The peer's in-flight op anchors
 *     adjacent to the tombstoned region (Yjs item-resolution under
 *     tombstones — typically position 0 or the end), NOT fragmented
 *     across the agent's content.
 *
 *     Under DMP-incremental (`composeAndWriteRawBody` → `applyFastDiff`),
 *     shared prefix/suffix bytes are preserved
 *     across the diff and the peer's op anchors INSIDE the preserved
 *     region — fragmenting the agent's payload. `final.includes(payload)`
 *     would be false. The contract test asserts it is true.
 *
 * Layer 2 residue (peer's text surviving in the converged doc as a
 * visually-obvious-position hybrid) is a separate structural-failure
 * class (cross-time mutation). Yjs
 * preserves concurrent ops against tombstoned items by design; the
 * producer cannot retract them. This file does not assert on the
 * residue's exact shape — Yjs item-resolution internals can evolve, and
 * pinning the byte shape is Yjs-version-fragile. A separate product
 * decision will choose Layer 2 recovery policy.
 */
import { describe, expect, test } from 'bun:test';
import type { Document } from '@hocuspocus/server';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, applyAgentMarkdownWrite } from './agent-sessions.ts';

/**
 * Wrap a Y.Doc in the minimal `Document` shape `applyAgentMarkdownWrite`
 * expects. The production handler passes a Hocuspocus `Document`; here we
 * stub only the methods the primitive reaches for.
 */
function asDocument(ydoc: Y.Doc, name = 'doc.md'): Document {
  return {
    name,
    awareness: undefined,
    getText: (n: string) => ydoc.getText(n),
    getMap: (n: string) => ydoc.getMap(n),
    getXmlFragment: (n: string) => ydoc.getXmlFragment(n),
    transact: (fn: () => void, origin?: unknown) => ydoc.transact(fn, origin),
    on: ydoc.on.bind(ydoc),
    off: ydoc.off.bind(ydoc),
  } as unknown as Document;
}

/**
 * Two-way CRDT exchange. After this returns, both docs hold the merged
 * Yjs state per CRDT semantics.
 */
function exchangeUpdates(a: Y.Doc, b: Y.Doc): void {
  const aState = Y.encodeStateVector(a);
  const bState = Y.encodeStateVector(b);
  const aDiff = Y.encodeStateAsUpdate(a, bState);
  const bDiff = Y.encodeStateAsUpdate(b, aState);
  Y.applyUpdate(b, aDiff);
  Y.applyUpdate(a, bDiff);
}

describe('applyAgentMarkdownWrite(replace) — CRDT-level convergence (PRD-6667)', () => {
  test('single-writer convergence: peer fully synced before replace, converged Y.Text equals agent payload', () => {
    const server = new Y.Doc();
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), '# Initial\n\nInitial body.\n', 'replace');
    }, AGENT_WRITE_ORIGIN);

    // Peer fully syncs from server.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe('# Initial\n\nInitial body.\n');

    // Agent replaces. No in-flight peer ops.
    const payload = '# Replaced\n\nCompletely new body content.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), payload, 'replace');
    }, AGENT_WRITE_ORIGIN);

    // Server's local view post-transact: matches payload exactly.
    expect(server.getText('source').toString()).toBe(payload);

    // After CRDT exchange the peer converges to the same bytes.
    exchangeUpdates(server, peer);
    expect(server.getText('source').toString()).toBe(payload);
    expect(peer.getText('source').toString()).toBe(payload);
  });

  test('concurrent peer typing during replace: agent payload survives as a contiguous substring (atomic primitive shape)', () => {
    const server = new Y.Doc();
    const peer = new Y.Doc();

    // Seed both with the same content.
    const initial = '# Original\n\nOriginal body that the peer cares about.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), initial, 'replace');
    }, AGENT_WRITE_ORIGIN);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe(initial);

    // Peer types locally — ops are issued on the peer's Y.Doc but not yet
    // shipped to the server (modeling an in-flight WebSocket window).
    const peerInsertOffset = initial.length - 1; // before trailing '\n'
    const peerText = ' PEER_TYPING';
    for (let i = 0; i < peerText.length; i++) {
      peer.getText('source').insert(peerInsertOffset + i, peerText.charAt(i));
    }
    expect(peer.getText('source').toString()).toContain('PEER_TYPING');
    // Server has not yet seen the peer's edits.
    expect(server.getText('source').toString()).toBe(initial);

    // Agent fires replace on the server.
    const agentPayload = '# Replaced By Agent\n\nAll original content should be gone.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), agentPayload, 'replace');
    }, AGENT_WRITE_ORIGIN);
    // Server's local view post-transact matches the payload exactly. The
    // atomic primitive's contract at the layer it executes — Layer 1.
    expect(server.getText('source').toString()).toBe(agentPayload);

    // Peer's in-flight updates arrive; server's update arrives at the
    // peer. CRDT merge resolves both peers to the same converged state.
    exchangeUpdates(server, peer);

    const serverFinal = server.getText('source').toString();
    const peerFinal = peer.getText('source').toString();

    // Both peers converge.
    expect(serverFinal).toBe(peerFinal);

    // Layer 1 contract under the atomic primitive: the agent's full
    // payload appears as a contiguous substring in the converged doc.
    // Under DMP-incremental, shared prefix/suffix
    // bytes would be preserved and the peer's in-flight insert would
    // anchor INSIDE the preserved region, fragmenting the agent payload.
    // With the atomic primitive, all prior items are tombstoned by the
    // full delete and the agent's content is inserted as a contiguous
    // block of fresh items; the peer's op anchors adjacent to the
    // tombstoned region (not interior to the agent's content).
    expect(serverFinal).toContain(agentPayload);

    // Layer 2 residue (peer's text surviving in the converged doc) is a
    // separate structural-failure class (cross-time mutation). Yjs
    // preserves concurrent ops against tombstones by design; the producer
    // cannot retract them. We do NOT assert on the residue's exact shape
    // since Yjs item-resolution internals can evolve.
  });
});
