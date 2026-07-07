/**
 * Bug-A mechanism isolation — empirical reproducer.
 *
 * Hypothesis: when a client types in WYSIWYG and an agent-write API call
 * fires within the client's Observer A 50ms debounce window, server-side
 * syncTextToFragment rebuilds server's XmlFragment from server's stale
 * Y.Text — destroying user content that was in server's XmlFragment (via
 * CRDT propagation) but not yet in server's Y.Text.
 *
 * Method: real Hocuspocus server + real HocuspocusProvider client over
 * WebSocket. Inspect server-side Y.Doc state at each critical moment
 * (same-process access).
 *
 * Iron Law: NO production code modified.
 */

import { describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  mdManager,
  schema,
  type TestClient,
  type TestServer,
  testReset,
} from './test-harness';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Apply markdown to client XmlFragment via updateYFragment — simulates WYSIWYG edit. */
function applyMarkdownToFragment(client: TestClient, md: string): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  client.doc.transact(() => {
    const meta = { mapping: new Map(), isOMark: new Map() };
    updateYFragment(client.doc, client.fragment, pmNode, meta);
  });
}

/** Serialize XmlFragment → Markdown string. */
function serializeFrag(
  fragment: { length: number } & Parameters<typeof yXmlFragmentToProseMirrorRootNode>[0],
): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON());
}

/** Capture server-side Y.Text + XmlFragment state for a given docName. */
function captureServerState(
  server: TestServer,
  docName: string,
  label: string,
): { ytext: string | null; frag: string | null } {
  const sd = server.instance.hocuspocus.documents.get(docName);
  if (!sd) {
    console.log(`[${label}] server doc NOT LOADED`);
    return { ytext: null, frag: null };
  }
  const ytext = sd.getText('source').toString();
  const frag = serializeFrag(sd.getXmlFragment('default'));
  console.log(`[${label}] server.ytext (${ytext.length}): ${JSON.stringify(ytext.slice(0, 300))}`);
  console.log(`[${label}] server.frag  (${frag.length}): ${JSON.stringify(frag.slice(0, 300))}`);
  return { ytext, frag };
}

// ═════════════════════════════════════════════════════════════
// Bug-A mechanism isolation
// ═════════════════════════════════════════════════════════════

describe('Bug-A mechanism isolation: server stomp via syncTextToFragment', () => {
  let server: TestServer;

  // Use shared server for all timing variants
  const DOC_NAME = 'test-doc';

  /**
   * Run the Bug-A scenario with a configurable wait between the client's
   * XmlFragment mutation and the agent write API call.
   *
   * Returns structured evidence for verdict analysis.
   */
  async function runBugAScenario(delayMs: number): Promise<{
    delay: number;
    t1: { ytext: string | null; frag: string | null };
    t2: { ytext: string | null; frag: string | null };
    t3: { ytext: string | null; frag: string | null };
    clientFinal: { ytext: string; frag: string };
  }> {
    await testReset(server.port, DOC_NAME);
    await wait(200);
    const client = await createTestClient(server.port, DOC_NAME);

    try {
      // ── T0: baseline (empty doc after reset) ──
      captureServerState(server, DOC_NAME, `delay=${delayMs}/T0`);

      // ── Step 1: Client mutates XmlFragment (simulates WYSIWYG typing) ──
      // This schedules Observer A's 50ms debounce on the CLIENT. The XmlFragment
      // CRDT update propagates to server via WebSocket (~2-5ms on localhost).
      // Client Y.Text does NOT update until Observer A fires (50ms).
      applyMarkdownToFragment(client, 'user typed in WYSIWYG\n');

      // ── Step 2: Wait the configured delay ──
      // Goal: wait long enough for XmlFragment CRDT propagation to server, but
      // shorter than Observer A's 50ms debounce so server Y.Text is still stale.
      await wait(delayMs);

      // ── T1: server state BEFORE agent write ──
      const t1 = captureServerState(server, DOC_NAME, `delay=${delayMs}/T1`);

      // ── Step 3: Agent write via API ──
      // Server-side handler: ytext.insert + syncTextToFragment in single transaction.
      // syncTextToFragment reads Y.Text → parses → updateYFragment → replaces XmlFragment.
      await agentWriteMd(server.port, 'agent content X', {
        docName: DOC_NAME,
        position: 'append',
      });

      // ── T2: server state IMMEDIATELY after agent write ──
      const t2 = captureServerState(server, DOC_NAME, `delay=${delayMs}/T2`);

      // ── Step 4: Wait for full settle ──
      // Observer A debounce fires, client Y.Text gets user content, propagates
      // to server. Observer B processes any changes. Allow full convergence.
      await wait(800);

      // ── T3: final settled state ──
      const t3 = captureServerState(server, DOC_NAME, `delay=${delayMs}/T3`);

      const clientFinal = {
        ytext: client.ytext.toString(),
        frag: serializeFrag(client.fragment),
      };
      console.log(
        `[delay=${delayMs}/client-final] ytext: ${JSON.stringify(clientFinal.ytext.slice(0, 300))}`,
      );
      console.log(
        `[delay=${delayMs}/client-final] frag : ${JSON.stringify(clientFinal.frag.slice(0, 300))}`,
      );

      return { delay: delayMs, t1, t2, t3, clientFinal };
    } finally {
      await client.cleanup();
    }
  }

  // Create/teardown shared server
  test('setup', async () => {
    server = await createTestServer();
    expect(server.port).toBeGreaterThan(0);
  });

  /**
   * Run the scenario at multiple delay points to find the race window.
   * The race is real if ANY delay shows:
   *   T1: server.frag HAS 'user typed' + server.ytext DOES NOT
   *   T2: server.frag no longer has 'user typed' (post-agent-write stomp)
   */
  test('Bug-A timing sweep: delays 5, 15, 25ms', async () => {
    const delays = [5, 15, 25];
    const results: Awaited<ReturnType<typeof runBugAScenario>>[] = [];

    for (const d of delays) {
      results.push(await runBugAScenario(d));
    }

    console.log('\n========== BUG-A MECHANISM VERDICT ==========');
    console.log(
      'delay | T1.frag-has-user | T1.ytext-has-user | T2.frag-has-user | T3.frag-has-user | T3.frag-has-agent | client-has-user',
    );
    for (const r of results) {
      const t1f = r.t1.frag?.includes('user typed in WYSIWYG') ?? false;
      const t1y = r.t1.ytext?.includes('user typed in WYSIWYG') ?? false;
      const t2f = r.t2.frag?.includes('user typed in WYSIWYG') ?? false;
      const t3f = r.t3.frag?.includes('user typed in WYSIWYG') ?? false;
      const t3a = r.t3.frag?.includes('agent content X') ?? false;
      const cf = r.clientFinal.frag.includes('user typed in WYSIWYG');
      console.log(
        `${String(r.delay).padStart(5)} | ${String(t1f).padStart(16)} | ${String(t1y).padStart(17)} | ${String(t2f).padStart(16)} | ${String(t3f).padStart(16)} | ${String(t3a).padStart(17)} | ${String(cf).padStart(15)}`,
      );
    }

    // Identify the stomp pattern: T1 frag has user content but ytext doesn't, AND T2 frag lost it
    const stompFound = results.some((r) => {
      const t1FragHas = r.t1.frag?.includes('user typed in WYSIWYG') ?? false;
      const t1YTextLacks = !(r.t1.ytext?.includes('user typed in WYSIWYG') ?? false);
      const t2FragLost = !(r.t2.frag?.includes('user typed in WYSIWYG') ?? false);
      return t1FragHas && t1YTextLacks && t2FragLost;
    });

    if (stompFound) {
      console.log(
        '\n>>> BUG-A SERVER-STOMP CONFIRMED: found delay(s) where T1 server.frag has user content',
      );
      console.log(
        '    but server.ytext does not, AND T2 server.frag lost user content after agent write.',
      );
    } else {
      // Check which condition failed
      const anyT1FragHasUser = results.some((r) => r.t1.frag?.includes('user typed in WYSIWYG'));
      const anyT1YTextLacksUser = results.some(
        (r) => !(r.t1.ytext?.includes('user typed in WYSIWYG') ?? false),
      );
      if (!anyT1FragHasUser) {
        console.log(
          '\n>>> BUG-A PREMISE UNVERIFIED: no delay achieved server.frag having user content at T1.',
        );
        console.log(
          '    CRDT XmlFragment propagation may be slower than expected. Try longer delays.',
        );
      } else if (!anyT1YTextLacksUser) {
        console.log(
          '\n>>> BUG-A PREMISE CONTRADICTED: server.ytext had user content at T1 for all delays.',
        );
        console.log(
          '    Observer A may fire faster than 50ms, or Y.Text sync happens via different path.',
        );
      } else {
        console.log(
          '\n>>> BUG-A MECHANISM NOT OBSERVED: T1 conditions met but T2 frag still has user content.',
        );
        console.log(
          '    syncTextToFragment may not be destructive, or updateYFragment preserves existing content.',
        );
      }
    }

    // Also check for final data loss
    const anyFinalLoss = results.some((r) => !r.t3.frag?.includes('user typed in WYSIWYG'));
    console.log(`\nFinal data loss (user content missing at T3): ${anyFinalLoss}`);
    console.log('=============================================\n');

    // Soft assertion — test always passes, evidence is in logs
    expect(true).toBe(true);
  });

  test('teardown', async () => {
    await server.cleanup();
  });
});
