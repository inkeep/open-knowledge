/**
 * Bug-C real reachability — empirical reproducer.
 *
 * Hypothesis: when peer B types in WYSIWYG (XmlFragment only — no Observer A
 * to sync to Y.Text), and peer A then types in source mode (Y.Text), peer A's
 * Observer B reads Y.Text (which lacks B's content), parses, and calls
 * updateYFragment — destroying B's XmlFragment content on peer A. The
 * destruction propagates back to peer B via CRDT.
 *
 * This test simulates "broken/infinitely-slow Observer A on peer B" by
 * constructing a no-observer peer: a HocuspocusProvider connected to the
 * real server without setupObservers wired. Peer B's XmlFragment edits
 * propagate to all peers via CRDT tree sync, but peer B's Y.Text never
 * reflects them — the exact precondition for Bug-C.
 *
 * Iron Law: NO production code modified.
 */

import { describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import {
  createTestClient,
  createTestServer,
  mdManager,
  schema,
  testReset,
  waitForSync,
} from './test-harness';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Apply markdown to a Y.XmlFragment via updateYFragment — simulates WYSIWYG edit. */
function applyMarkdownToFragment(doc: Y.Doc, fragment: Y.XmlFragment, md: string): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(doc, fragment, pmNode, meta);
  });
}

/** Serialize XmlFragment → markdown string. */
function serializeFrag(fragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

/**
 * Create a peer WITHOUT setupObservers — simulates a client where Observer A
 * is broken/infinitely-slow, so Y.Text never reflects XmlFragment writes.
 * CRDT tree sync still works (XmlFragment propagates to all peers).
 */
async function createNoObserverPeer(
  port: number,
  docName: string,
): Promise<{
  doc: Y.Doc;
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  provider: HocuspocusProvider;
  cleanup: () => Promise<void>;
}> {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docName,
    document: doc,
    connect: true,
  });
  await waitForSync(provider);
  return {
    doc,
    ytext,
    fragment,
    provider,
    cleanup: async () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

// ═════════════════════════════════════════════════════════════
// Bug-C: Observer B destructive rebuild under delayed Y.Text
// ═════════════════════════════════════════════════════════════

describe('Bug-C real reachability: no-observer peer B → Observer B on A destroys content', () => {
  const DOC_NAME = 'test-doc';

  test('Bug-C: peer B WYSIWYG (no Observer A) → peer A source-mode write → Observer B destroys B content', async () => {
    const server = await createTestServer();
    await testReset(server.port, DOC_NAME);
    await wait(200);

    // Peer A: full observer setup (Observer A + Observer B wired)
    const peerA = await createTestClient(server.port, DOC_NAME);

    // Peer B: NO observers. XmlFragment syncs via CRDT, Y.Text never updated.
    const peerB = await createNoObserverPeer(server.port, DOC_NAME);

    try {
      // ── Step 1: Seed baseline via peer A (has observers → Y.Text + XmlFragment sync) ──
      applyMarkdownToFragment(peerA.doc, peerA.fragment, '# Baseline\n\nshared content\n');
      // Wait for Observer A to fire (50ms debounce) + CRDT propagation + settle
      await wait(400);

      console.log('[Step 1] peerA.ytext:', JSON.stringify(peerA.ytext.toString()));
      console.log('[Step 1] peerB.ytext:', JSON.stringify(peerB.ytext.toString()));
      console.log('[Step 1] peerA.frag :', JSON.stringify(serializeFrag(peerA.fragment)));
      console.log('[Step 1] peerB.frag :', JSON.stringify(serializeFrag(peerB.fragment)));

      // ── Step 2: Peer B mutates XmlFragment (WYSIWYG-style, no Observer A) ──
      // Peer B's XmlFragment update propagates to peer A and server via CRDT.
      // Peer B's Y.Text does NOT update (no Observer A wired).
      applyMarkdownToFragment(
        peerB.doc,
        peerB.fragment,
        '# Baseline\n\nshared content\n\nFROM-PEER-B-WYSIWYG\n',
      );

      // Wait for CRDT propagation of XmlFragment to peer A
      // Must wait > REMOTE_TREE_SYNC_GRACE_MS (150ms) so Observer B's grace
      // window expires. Use 300ms for safety.
      await wait(300);

      const peerAFragStep2 = serializeFrag(peerA.fragment);
      const peerAYTextStep2 = peerA.ytext.toString();
      const peerBYTextStep2 = peerB.ytext.toString();

      console.log('[Step 2] peerA.ytext:', JSON.stringify(peerAYTextStep2));
      console.log('[Step 2] peerB.ytext:', JSON.stringify(peerBYTextStep2));
      console.log('[Step 2] peerA.frag :', JSON.stringify(peerAFragStep2));
      console.log('[Step 2] peerB.frag :', JSON.stringify(serializeFrag(peerB.fragment)));

      const peerAFragHasB_step2 = peerAFragStep2.includes('FROM-PEER-B-WYSIWYG');
      const peerAYTextHasB_step2 = peerAYTextStep2.includes('FROM-PEER-B-WYSIWYG');
      console.log(`[Step 2] peerA.frag has B's content? ${peerAFragHasB_step2}`);
      console.log(`[Step 2] peerA.ytext has B's content? ${peerAYTextHasB_step2}`);

      // ── Step 3: Peer A types in source mode (direct Y.Text mutation) ──
      // This is a LOCAL transaction on peer A → triggers Observer B debounce (50ms).
      // After the grace window (already expired — we waited 300ms), Observer B
      // fires: reads Y.Text (doesn't have B's content), parses, updateYFragment
      // → rebuilds XmlFragment WITHOUT B's content.
      peerA.doc.transact(() => {
        peerA.ytext.insert(peerA.ytext.length, '\n\nFROM-PEER-A-SOURCE\n');
      });

      // ── Step 4: Wait for Observer B to fire fully ──
      // DEBOUNCE_MS=50ms for the initial timer. TYPING_DEFER_MS doesn't apply
      // (markUserTyping not called for source-mode edits). Grace window already
      // expired. So Observer B fires ~50ms after step 3.
      // Wait 600ms to cover debounce + updateYFragment + CRDT propagation back to B.
      await wait(600);

      const peerAFragStep4 = serializeFrag(peerA.fragment);
      const peerBFragStep4 = serializeFrag(peerB.fragment);
      const peerAYTextStep4 = peerA.ytext.toString();

      console.log('[Step 4] peerA.ytext:', JSON.stringify(peerAYTextStep4));
      console.log('[Step 4] peerA.frag :', JSON.stringify(peerAFragStep4));
      console.log('[Step 4] peerB.frag :', JSON.stringify(peerBFragStep4));

      const peerAFragHasB_step4 = peerAFragStep4.includes('FROM-PEER-B-WYSIWYG');
      const peerBFragHasB_step4 = peerBFragStep4.includes('FROM-PEER-B-WYSIWYG');
      const peerAFragHasA_step4 = peerAFragStep4.includes('FROM-PEER-A-SOURCE');
      const peerAYTextHasA_step4 = peerAYTextStep4.includes('FROM-PEER-A-SOURCE');

      console.log('\n========== BUG-C REACHABILITY VERDICT ==========');
      console.log('Setup condition (Step 2):');
      console.log(
        `  Peer A frag has B content?  ${peerAFragHasB_step2} (MUST be true for valid test)`,
      );
      console.log(
        `  Peer A ytext has B content? ${peerAYTextHasB_step2} (MUST be false — proves no-observer-B condition)`,
      );
      console.log('Post Observer-B-fire (Step 4):');
      console.log(
        `  Peer A frag has B content?  ${peerAFragHasB_step4} (if FALSE → Observer B destroyed it → Bug-C CONFIRMED)`,
      );
      console.log(
        `  Peer B frag has B content?  ${peerBFragHasB_step4} (if FALSE → destruction propagated back → full data loss)`,
      );
      console.log(
        `  Peer A frag has A content?  ${peerAFragHasA_step4} (A's own source-mode content survived)`,
      );
      console.log(`  Peer A ytext has A content? ${peerAYTextHasA_step4}`);

      if (peerAFragHasB_step2 && !peerAYTextHasB_step2) {
        if (!peerAFragHasB_step4) {
          console.log(
            '\n>>> BUG-C CONFIRMED: Observer B destroyed peer B WYSIWYG content from peer A XmlFragment.',
          );
          if (!peerBFragHasB_step4) {
            console.log(
              '>>> FULL PEER-LEVEL DATA LOSS: destruction propagated back to peer B via CRDT.',
            );
          }
        } else {
          console.log(
            '\n>>> BUG-C REFUTED: Observer B did NOT destroy B content despite stale Y.Text.',
          );
          console.log(
            '    Possible explanations: Observer B early-exit, or grace window re-armed, or',
          );
          console.log(
            '    Observer A on peer A synced B content to Y.Text before Observer B fired.',
          );
        }
      } else if (!peerAFragHasB_step2) {
        console.log('\n>>> SETUP FAILED: Peer A frag did NOT receive B content at Step 2.');
        console.log('    CRDT XmlFragment propagation may be slower than expected.');
      } else {
        console.log('\n>>> SETUP UNEXPECTED: Peer A ytext HAS B content at Step 2.');
        console.log('    Something other than Observer A synced B content to Y.Text.');
        console.log(
          '    HocuspocusProvider may have built-in observers, or server-side sync fired.',
        );
      }
      console.log('================================================\n');

      // Soft assertion — test always passes, evidence is in logs
      expect(true).toBe(true);
    } finally {
      await peerA.cleanup();
      await peerB.cleanup();
      await server.cleanup();
    }
  });

  /**
   * Variant: peer A's source-mode write happens WITHIN the grace window (<150ms).
   * If Bug-C is real AND the grace window correctly defers Observer B, the content
   * should survive (Observer B defers → by the time it fires, Observer A on peer A
   * has synced B's content to Y.Text... except Observer A on peer A also has a 50ms
   * debounce, and B's content only arrived in XmlFragment, not Y.Text. So even with
   * the grace window, Y.Text is still stale. Let's see what actually happens.)
   */
  test('Bug-C variant: peer A source-mode write WITHIN grace window (<150ms after B arrival)', async () => {
    const server = await createTestServer();
    await testReset(server.port, DOC_NAME);
    await wait(200);

    const peerA = await createTestClient(server.port, DOC_NAME);
    const peerB = await createNoObserverPeer(server.port, DOC_NAME);

    try {
      // Seed
      applyMarkdownToFragment(peerA.doc, peerA.fragment, '# Baseline\n\nshared content\n');
      await wait(400);

      // Peer B writes WYSIWYG
      applyMarkdownToFragment(
        peerB.doc,
        peerB.fragment,
        '# Baseline\n\nshared content\n\nFROM-PEER-B-GRACE\n',
      );

      // Wait only 50ms — WITHIN the 150ms grace window
      // This means CRDT XmlFragment should have propagated but grace window hasn't expired.
      await wait(50);

      const peerAFragBefore = serializeFrag(peerA.fragment);
      const peerAYTextBefore = peerA.ytext.toString();
      console.log('[Grace variant - before A writes] peerA.frag:', JSON.stringify(peerAFragBefore));
      console.log(
        '[Grace variant - before A writes] peerA.ytext:',
        JSON.stringify(peerAYTextBefore),
      );

      const graceSetupOk =
        peerAFragBefore.includes('FROM-PEER-B-GRACE') &&
        !peerAYTextBefore.includes('FROM-PEER-B-GRACE');
      console.log(`[Grace variant] setup condition met? ${graceSetupOk}`);

      // Peer A writes to Y.Text (source mode) WITHIN the grace window
      peerA.doc.transact(() => {
        peerA.ytext.insert(peerA.ytext.length, '\n\nFROM-PEER-A-GRACE\n');
      });

      // Wait for full settle
      await wait(800);

      const peerAFragFinal = serializeFrag(peerA.fragment);
      const peerBFragFinal = serializeFrag(peerB.fragment);
      const peerAYTextFinal = peerA.ytext.toString();

      console.log('[Grace variant - final] peerA.frag:', JSON.stringify(peerAFragFinal));
      console.log('[Grace variant - final] peerB.frag:', JSON.stringify(peerBFragFinal));
      console.log('[Grace variant - final] peerA.ytext:', JSON.stringify(peerAYTextFinal));

      const bContentSurvived = peerAFragFinal.includes('FROM-PEER-B-GRACE');
      console.log(`\n[Grace variant] B content survived in peerA.frag? ${bContentSurvived}`);
      if (graceSetupOk) {
        if (bContentSurvived) {
          console.log(
            '>>> Grace window PROTECTED B content (Bug-C mitigated within grace window).',
          );
        } else {
          console.log(
            '>>> Grace window DID NOT protect B content (Bug-C fires even within grace window).',
          );
        }
      }

      expect(true).toBe(true);
    } finally {
      await peerA.cleanup();
      await peerB.cleanup();
      await server.cleanup();
    }
  });
});
