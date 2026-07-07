/**
 * `applyAgentMarkdownWrite(..., 'patch')` under CRDT-level convergence — the
 * INCREMENTAL counterpart to `agent-write-replace-crdt-convergence.test.ts`.
 *
 * `edit_document` (handleAgentPatch) computes a full recomposed body from a
 * find/replace and writes it via position `'patch'`, which routes to the
 * item-preserving primitive (`composeAndWriteRawBody` → `applyFastDiff`), NOT
 * the atomic `replaceRawBody`. The distinguishing observable: a concurrent peer
 * edit OUTSIDE the patched span survives IN PLACE — woven into the surrounding
 * content it was typed into — because the un-patched items keep their identity.
 * Under the atomic primitive (the pre-fix regression) the full delete tombstones
 * every item including the peer's region, and the peer's in-flight op re-anchors
 * at the tombstone seam: displaced, not woven.
 *
 * This is the mirror of the replace contract. Replace asserts the AGENT's
 * payload stays contiguous (atomic shape); patch asserts the PEER's concurrent
 * edit stays woven in its original context (incremental shape). One primitive
 * cannot satisfy both — which is exactly why `position: 'replace'` was
 * de-overloaded into `replace` (atomic) and `patch` (incremental).
 */
import { describe, expect, test } from 'bun:test';
import type { Document } from '@hocuspocus/server';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, applyAgentMarkdownWrite } from './agent-sessions.ts';

/**
 * Wrap a Y.Doc in the minimal `Document` shape `applyAgentMarkdownWrite`
 * expects (mirrors the sibling replace-convergence test's stub).
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

/** Two-way CRDT exchange — both docs hold the merged state afterward. */
function exchangeUpdates(a: Y.Doc, b: Y.Doc): void {
  const aState = Y.encodeStateVector(a);
  const bState = Y.encodeStateVector(b);
  const aDiff = Y.encodeStateAsUpdate(a, bState);
  const bDiff = Y.encodeStateAsUpdate(b, aState);
  Y.applyUpdate(b, aDiff);
  Y.applyUpdate(a, bDiff);
}

/**
 * What `handleAgentPatch` computes before the write: the full document with the
 * first occurrence of `find` replaced by `replace`. Routed through position
 * `'patch'` in the production handler.
 */
function patchBody(current: string, find: string, replace: string): string {
  const pos = current.indexOf(find);
  if (pos === -1) throw new Error(`find not present: ${find}`);
  return current.slice(0, pos) + replace + current.slice(pos + find.length);
}

const INITIAL = '# Doc\n\nIntro with the OLDWORD token.\n\nSecond para the peer cares about.\n';

describe('applyAgentMarkdownWrite(patch) — CRDT-level convergence (edit_document item-preservation)', () => {
  test('single-writer convergence: peer synced before patch, converged Y.Text equals patched body', () => {
    const server = new Y.Doc();
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), INITIAL, 'replace');
    }, AGENT_WRITE_ORIGIN);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe(INITIAL);

    const patched = patchBody(INITIAL, 'OLDWORD', 'NEWWORD');
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), patched, 'patch');
    }, AGENT_WRITE_ORIGIN);
    expect(server.getText('source').toString()).toBe(patched);

    exchangeUpdates(server, peer);
    expect(server.getText('source').toString()).toBe(patched);
    expect(peer.getText('source').toString()).toBe(patched);
  });

  test('concurrent peer edit outside the patched span survives item-preserved (woven in place)', () => {
    const server = new Y.Doc();
    const peer = new Y.Doc();

    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), INITIAL, 'replace');
    }, AGENT_WRITE_ORIGIN);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe(INITIAL);

    // Peer types INTO the second paragraph (far from OLDWORD) — in-flight,
    // not yet shipped to the server.
    const peerMarker = 'PEER_TYPING ';
    const peerInsertOffset = INITIAL.indexOf('cares about'); // before "cares"
    for (let i = 0; i < peerMarker.length; i++) {
      peer.getText('source').insert(peerInsertOffset + i, peerMarker.charAt(i));
    }
    expect(peer.getText('source').toString()).toContain('peer PEER_TYPING cares about');
    expect(server.getText('source').toString()).toBe(INITIAL); // server hasn't seen it

    // Agent patches a DIFFERENT region (OLDWORD -> NEWWORD) via 'patch'.
    const patched = patchBody(INITIAL, 'OLDWORD', 'NEWWORD');
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), patched, 'patch');
    }, AGENT_WRITE_ORIGIN);
    expect(server.getText('source').toString()).toBe(patched);

    exchangeUpdates(server, peer);
    const serverFinal = server.getText('source').toString();
    const peerFinal = peer.getText('source').toString();

    // Both peers converge.
    expect(serverFinal).toBe(peerFinal);
    // The agent's change applied.
    expect(serverFinal).toContain('NEWWORD');
    expect(serverFinal).not.toContain('OLDWORD');
    // The peer's concurrent edit survives...
    expect(serverFinal).toContain('PEER_TYPING');
    // ...AND stays woven into its ORIGINAL context. THE DISCRIMINATOR: under the
    // incremental primitive the second paragraph's items are untouched by the
    // patch, so the peer's insert keeps its position. Under the atomic primitive
    // (the regression) the full delete tombstones that region and the peer's op
    // re-anchors at the seam — displaced — breaking this contiguous phrase.
    expect(serverFinal).toContain('peer PEER_TYPING cares about');
  });
});
