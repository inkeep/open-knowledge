/**
 * A stale client structural fragment replace must never end up as duplicated
 * authoritative Y.Text bytes.
 *
 * The race: while a user types per-keystroke into `Y.Text('source')`, server
 * Observer B rewrites the `Y.XmlFragment('default')` on every keystroke drain.
 * The keystroke that closes an unregistered `<Steps>`/`<Step>` block flips the
 * span's parse from a rawMdxFallback node to a valid wildcard jsxComponent — a
 * STRUCTURAL delete+insert of the span, not an item-preserving content update.
 * Concurrently, the hidden-but-mounted client WYSIWYG editor's wildcard
 * JsxComponentView auto-convert dispatches its own plain client-origin
 * `replaceWith` (also a structural delete+insert) of the SAME span, computed
 * against a fragment state that has lagged the server's rewrites. At the
 * Y.XmlFragment CRDT level the two concurrent delete+insert pairs merge as one
 * agreed delete plus BOTH inserts surviving, so the Step subtree materializes
 * twice. Observer A then serializes the doubled fragment and faithfully
 * persists the duplicated bytes into the authoritative Y.Text.
 *
 * Why raw Y.js emulation instead of driving the React editor: the invariant
 * under test is server-side — a stale client structural fragment replace must
 * not survive into authoritative Y.Text, regardless of which client surface
 * minted it. Emulating the auto-convert directly at the `client.fragment`
 * delete/insert level pins that server/bridge contract without coupling the
 * test to JsxComponentView's rAF scheduling, its per-instance idempotence
 * guard, or any editor mount lifecycle. It is the stronger contract: any
 * client that issues a concurrent structural replace of a bridge-derived span
 * reproduces this, not just the one dispatcher that happens to exist today.
 *
 * Why the assertion is at the server Y.Text level: that is the authoritative
 * source persisted to disk and converged to every peer (precedent #38,
 * Y.Text-is-truth). The corruption is real bytes there, self-stabilizing, with
 * no downstream self-heal — so the server Y.Text multiplicity is the invariant
 * that matters.
 *
 * The interleave is staged deterministically with syncControl: the client
 * pauses INBOUND sync (so it never sees Observer B's rewrites — the stale
 * replica), types the closing tags per-keystroke (outbound still flows, so the
 * server rewrites the span per keystroke), then performs the
 * auto-convert-equivalent structural replace against its stale fragment. On
 * resume the server fragment holds two copies of the Step subtree and the
 * authoritative Y.Text duplicates the typed body line.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  getServerState,
  type TestClient,
  type TestServer,
} from './test-harness';

// Seeded UNCLOSED — the fragment materializes a rawMdxFallback (parse-error)
// node for the span. Typing the closing tags flips the parse to a valid
// wildcard jsxComponent, which is a STRUCTURAL replace by Observer B (not an
// item-preserving content update) — one side of the concurrent replace pair.
const STEPS_UNCLOSED = [
  '## Guide',
  '',
  'Intro paragraph.',
  '',
  '<Steps>',
  '',
  '<Step>',
  '',
  'Step one body.',
  '',
].join('\n');
const CLOSING = '</Step>\n\n</Steps>\n';

let server: TestServer;
let client: TestClient;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await client?.cleanup();
  await server?.cleanup();
});

test('concurrent client structural replace vs Observer-B rewrite must not duplicate the Step subtree', async () => {
  client = await createTestClient(server.port, undefined, {
    syncControl: true,
    // We deliberately drive divergence — the watcher would throw first.
    skipInvariantWatcher: true,
  });

  // Seed the doc UNCLOSED through the client Y.Text (source-mode surface, W2).
  client.doc.transact(() => {
    client.ytext.insert(0, STEPS_UNCLOSED);
  });
  await awaitDocQuiescence(client.doc, { timeoutMs: 10_000, idleTicks: 5 });

  const pre = getServerState(server, client.docName);
  expect(pre).not.toBeNull();
  expect(pre?.ytext.toString().match(/Step one body\./g)?.length).toBe(1);

  // ── Open the concurrency window ──────────────────────────────────────
  // Client stops SEEING server-side Observer-B fragment rewrites (inbound
  // paused), exactly like a CPU-starved renderer whose WS deltas lag.
  client.pauseSync();

  // Type the CLOSING tags per-keystroke (outbound flows). At the final
  // keystrokes the server-side parse flips the span from rawMdxFallback to
  // a valid wildcard jsxComponent — Observer B performs a STRUCTURAL
  // delete+insert on the span.
  let at = client.ytext.length;
  for (const ch of CLOSING) {
    client.doc.transact(() => {
      client.ytext.insert(at, ch);
    });
    at += 1;
  }

  // Auto-convert-equivalent structural replace, computed against the
  // client's STALE fragment (paused inbound — it still holds the seed-era
  // paragraphs for the unclosed span; the server has meanwhile folded the
  // span into one jsxComponent). Mirrors the JsxComponentView auto-convert
  // replaceWith: delete the stale span items and insert ONE rawMdxFallback
  // element whose text is the stale source snapshot — the exact byte-shape
  // observed as the surviving orphan copy in the corrupted drains. Plain
  // client origin, like the real dispatch. Inbound is paused, so the client
  // fragment never changes after seed; only its Y.Text advanced. The stale
  // span is the paragraphs at indices 2..4.
  expect(client.fragment.length).toBeGreaterThanOrEqual(5);
  const fallback = new Y.XmlElement('rawMdxFallback');
  fallback.setAttribute('reason', 'Unregistered component: Step');
  fallback.insert(0, [new Y.XmlText('<Step>\n\nStep one body.\n\n</Step>')]);
  client.doc.transact(() => {
    client.fragment.delete(2, 3);
    client.fragment.insert(2, [fallback]);
  });

  // ── Close the window: let the server's queued rewrites reach the client
  // and the final settlement run. ──────────────────────────────────────
  client.resumeSync();
  await awaitDocQuiescence(client.doc, { timeoutMs: 15_000, idleTicks: 10 });

  const post = getServerState(server, client.docName);
  expect(post).not.toBeNull();
  const bytes = post?.ytext.toString() ?? '';

  // INVARIANT (the duplication-gate recovery upholds this): the typed body
  // line appears exactly once and the container tags stay singular in the
  // authoritative bytes.
  expect(bytes.match(/Step one body\./g)?.length ?? 0).toBe(1);
  expect(bytes.match(/<Step>/g)?.length ?? 0).toBe(1);
  expect(bytes.match(/<Steps>/g)?.length ?? 0).toBe(1);

  // Post-recovery bridge coherence: the re-derived server fragment must agree
  // with Y.Text (a recovery that fixed the bytes but left a doubled fragment
  // would just re-trip the gate on the next drain).
  expect(post?.md.match(/Step one body\./g)?.length ?? 0).toBe(1);
  expect(post?.md.match(/<Step>/g)?.length ?? 0).toBe(1);
}, 30_000);
