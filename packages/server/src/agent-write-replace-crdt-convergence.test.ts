import { describe, expect, test } from 'bun:test';
import type { Document } from '@hocuspocus/server';
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

describe('applyAgentMarkdownWrite(replace) — CRDT-level convergence (PRD-6667)', () => {
  test('single-writer convergence: peer fully synced before replace, converged Y.Text equals agent payload', () => {
    const server = new Y.Doc();
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), '# Initial\n\nInitial body.\n', 'replace');
    }, AGENT_WRITE_ORIGIN);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe('# Initial\n\nInitial body.\n');

    const payload = '# Replaced\n\nCompletely new body content.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), payload, 'replace');
    }, AGENT_WRITE_ORIGIN);

    expect(server.getText('source').toString()).toBe(payload);

    exchangeUpdates(server, peer);
    expect(server.getText('source').toString()).toBe(payload);
    expect(peer.getText('source').toString()).toBe(payload);
  });

  test('concurrent peer typing during replace: agent payload survives as a contiguous substring (atomic primitive shape)', () => {
    const server = new Y.Doc();
    const peer = new Y.Doc();

    const initial = '# Original\n\nOriginal body that the peer cares about.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), initial, 'replace');
    }, AGENT_WRITE_ORIGIN);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    expect(peer.getText('source').toString()).toBe(initial);

    const peerInsertOffset = initial.length - 1; // before trailing '\n'
    const peerText = ' PEER_TYPING';
    for (let i = 0; i < peerText.length; i++) {
      peer.getText('source').insert(peerInsertOffset + i, peerText.charAt(i));
    }
    expect(peer.getText('source').toString()).toContain('PEER_TYPING');
    expect(server.getText('source').toString()).toBe(initial);

    const agentPayload = '# Replaced By Agent\n\nAll original content should be gone.\n';
    server.transact(() => {
      applyAgentMarkdownWrite(asDocument(server), agentPayload, 'replace');
    }, AGENT_WRITE_ORIGIN);
    expect(server.getText('source').toString()).toBe(agentPayload);

    exchangeUpdates(server, peer);

    const serverFinal = server.getText('source').toString();
    const peerFinal = peer.getText('source').toString();

    expect(serverFinal).toBe(peerFinal);

    expect(serverFinal).toContain(agentPayload);
  });
});
