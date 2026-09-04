import type { Document } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, applyAgentMarkdownWrite } from './agent-sessions.ts';

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

function exchangeUpdates(a: Y.Doc, b: Y.Doc): void {
  const aState = Y.encodeStateVector(a);
  const bState = Y.encodeStateVector(b);
  const aDiff = Y.encodeStateAsUpdate(a, bState);
  const bDiff = Y.encodeStateAsUpdate(b, aState);
  Y.applyUpdate(b, aDiff);
  Y.applyUpdate(a, bDiff);
}

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

    const peerMarker = 'PEER_TYPING ';
    const peerInsertOffset = INITIAL.indexOf('cares about');
    for (let i = 0; i < peerMarker.length; i++) {
      peer.getText('source').insert(peerInsertOffset + i, peerMarker.charAt(i));
    }
    expect(peer.getText('source').toString()).toContain('peer PEER_TYPING cares about');
    expect(server.getText('source').toString()).toBe(INITIAL);

    const patched = patchBody(INITIAL, 'OLDWORD', 'NEWWORD');
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), patched, 'patch');
    }, AGENT_WRITE_ORIGIN);
    expect(server.getText('source').toString()).toBe(patched);

    exchangeUpdates(server, peer);
    const serverFinal = server.getText('source').toString();
    const peerFinal = peer.getText('source').toString();

    expect(serverFinal).toBe(peerFinal);
    expect(serverFinal).toContain('NEWWORD');
    expect(serverFinal).not.toContain('OLDWORD');
    expect(serverFinal).toContain('PEER_TYPING');
    expect(serverFinal).toContain('peer PEER_TYPING cares about');
  });
});
