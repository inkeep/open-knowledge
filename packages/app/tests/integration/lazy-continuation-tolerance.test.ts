/**
 * Regression pin: paragraph lazy-continuation indent (normalizeBridge).
 * Deterministic repro distilled from fuzz seed 1781126191758.
 *
 * A Y.Text byte form containing a paragraph soft-break continuation line
 * with leading whitespace ("para two\n continuation") is parse-invisible
 * (CommonMark lazy continuation strips the space) and MUST therefore be an
 * enumerated normalizeBridge tolerance class: Y.Text-is-truth forbids any
 * corrective canonicalizing write, Observer B's re-derive is a fixed point
 * (fragment already equals parse(ytext)), and the byte-preserving Observer
 * A routes keep the residual byte across subsequent edits — so before the
 * class was enumerated the doc rested beyond tolerance forever (perpetual
 * split-brain telemetry; the fuzz harness classified it `stalled`; a
 * cross-generation merge could even DUPLICATE the residual block).
 */
import { describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import {
  agentWriteMd,
  assertBridgeInvariant,
  awaitDocQuiescence,
  classifyFinalState,
  createTestClients,
  createTestServer,
} from './test-harness';

describe('paragraph lazy-continuation indent — doc settles within tolerance', () => {
  test('leading-space continuation line converges and the invariant holds', async () => {
    const server = await createTestServer();
    const docName = `stall-repro-${Date.now()}`;
    try {
      await agentWriteMd(server.port, 'seed paragraph\n', { docName, position: 'replace' });
      await wait(200);
      const clients = await createTestClients(server.port, {
        count: 2,
        docName,
        perClientOptions: { skipInvariantWatcher: true },
      });
      const [c0, c1] = clients;
      try {
        // W2 source-surface write: paragraph + soft-break continuation line
        // with ONE leading space (a source-mode user can type exactly this;
        // the fuzz seed manufactures it via chunk/append interleaving).
        c0.doc.transact(() => {
          c0.ytext.insert(c0.ytext.length, '\n\npara two\n continuation text');
        });
        await awaitDocQuiescence(c0.doc, { timeoutMs: 3000 });
        await wait(300);
        await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));

        // Organic follow-up edit on the OTHER client (does not touch the
        // residual block) — pre-program this would canonicalize the doc and
        // self-heal; post-program byte-preserving routes keep the residual.
        const paragraph = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.applyDelta([{ insert: 'healer edit' }]);
        paragraph.insert(0, [t]);
        c1.fragment.push([paragraph]);
        await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
        await wait(300);

        // classifyFinalState is the budget-exhaustion classifier: a settled
        // good state is 'converged-late' by construction ('converged' is
        // only minted by the in-budget convergence loop).
        const outcome = classifyFinalState(clients);
        expect(outcome.outcome).toBe('converged-late');
        for (const c of clients) {
          assertBridgeInvariant(c.ytext, c.fragment);
        }
        // The residual byte SURVIVES (storage never sanitizes) …
        const finalText = c0.ytext.toString();
        expect(finalText).toContain('\n continuation text');
        // … the healer edit landed …
        expect(finalText).toContain('healer edit');
        // … and the pre-fix duplication amplification is gone: the block
        // appears exactly once (no canonical-twin insert from a
        // cross-generation merge).
        expect(finalText.split('continuation text').length - 1).toBe(1);
      } finally {
        for (const c of clients) await c.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  }, 30_000);
});
