/**
 * Multi-client Y.Item identity regression test for rawMdxFallback.
 *
 * Verifies content-based shape (atom:false, content:'text*') preserves
 * Y.XmlElement identity when the inner text of a rawMdxFallback region is
 * edited character-by-character via source mode, with a second client
 * observing in WYSIWYG.
 *
 * Key assertions:
 *   - rawMdxFallback Y.XmlElement identity is stable across all keystrokes
 *     (same _item reference — no delete+reinsert)
 *   - Client B's WYSIWYG cursor (RelativePosition) in a non-fallback paragraph
 *     resolves to the same absolute position throughout
 *   - Per-keystroke Y.Doc update payloads are small (char-level delta, not
 *     whole-node replacement)
 *   - Y.Text edits propagate via CRDT sync between clients
 *
 * Note on bridge invariant: During active editing of broken MDX content,
 * Observer B freezes (preserves last valid XmlFragment). This means Y.Text
 * and XmlFragment diverge intentionally — the bridge invariant is temporarily
 * suspended until the content becomes valid again. This is by design.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  createTestClient,
  createTestServer,
  pollUntil,
  serializeFragment,
  type TestClient,
  type TestServer,
  testReset,
} from './test-harness';

// ─── Helpers ───

/** Walk Y.XmlFragment children to find the first rawMdxFallback element. */
function findRawMdxFallback(fragment: Y.XmlFragment): Y.XmlElement | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'rawMdxFallback') {
      return child;
    }
  }
  return null;
}

/** Walk Y.XmlFragment to find the Nth paragraph element (0-indexed). */
function findNthParagraph(fragment: Y.XmlFragment, n: number): Y.XmlElement | null {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'paragraph') {
      if (count === n) return child;
      count++;
    }
  }
  return null;
}

/** Get the first Y.XmlText child inside a Y.XmlElement. */
function getFirstXmlText(el: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) {
      return child;
    }
  }
  return null;
}

// ─── Test suite ───

describe('rawMdxFallback multi-client Y.Item identity (US-011, M8, Q5)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  let clientA: TestClient;
  let clientB: TestClient;

  beforeEach(async () => {
    await testReset(server.port);
    await wait(300);
    clientA = await createTestClient(server.port, 'test-doc');
    clientB = await createTestClient(server.port, 'test-doc');
  });

  afterEach(async () => {
    await clientA?.cleanup();
    await clientB?.cleanup();
    await wait(300);
  });

  test('rawMdxFallback Y.XmlElement identity preserved during source-mode char-by-char edits', async () => {
    // ── Step 1: Seed document with broken MDX via file write ──
    // Writing to the content file triggers file-watcher → external-change →
    // parseWithFallback → rawMdxFallback in Y.XmlFragment.
    const brokenContent =
      '# Top heading\n\nSafe paragraph above.\n\n<Foo>broken content</Bar>\n\n## Bottom heading\n\nSafe text below.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    // Wait for file watcher + external change to propagate to both clients
    await pollUntil(() => clientA.ytext.toString().includes('broken content'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('broken content'), 10_000);
    // Let observer debounces settle
    await wait(800);

    // ── Step 2: Verify rawMdxFallback exists in XmlFragment ──
    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    // ── Step 3: Capture initial state for identity comparison ──
    // Y.Item reference for identity tracking
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemBefore = (fallbackB! as unknown as { _item: unknown })._item;
    expect(itemBefore).toBeTruthy();

    // Capture serialized XmlFragment state on Client B for stability check
    const fragmentSerializedBefore = serializeFragment(clientB.fragment);

    // Create a RelativePosition in Client B's second paragraph (cursor proxy).
    // We target the Y.XmlText inside the paragraph at character offset 3.
    const bottomParagraph = findNthParagraph(clientB.fragment, 1);
    expect(bottomParagraph).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const bottomText = getFirstXmlText(bottomParagraph!);
    expect(bottomText).not.toBeNull();
    const cursorRelPos = Y.createRelativePositionFromTypeIndex(
      // biome-ignore lint/style/noNonNullAssertion: checked above
      bottomText!,
      3, // cursor at character offset 3 within the text
    );

    // ── Step 4: Client A makes 20 char-by-char Y.Text edits ──
    // Simulate source-mode typing inside the broken region.
    // Find the position of 'broken content' in Y.Text and append chars after it.
    const brokenTextStart = clientA.ytext.toString().indexOf('<Foo>broken content</Bar>');
    expect(brokenTextStart).toBeGreaterThanOrEqual(0);

    // Insert inside the broken tag content (after 'broken content', before '</Bar>')
    const insertPos = brokenTextStart + '<Foo>broken content'.length;

    const KEYSTROKE_COUNT = 20;
    const updateSizes: number[] = [];

    // Capture Y.Doc update sizes to verify char-level deltas
    const updateHandler = (update: Uint8Array) => {
      updateSizes.push(update.byteLength);
    };
    clientA.doc.on('update', updateHandler);

    for (let i = 0; i < KEYSTROKE_COUNT; i++) {
      clientA.doc.transact(() => {
        clientA.ytext.insert(insertPos + i, String.fromCharCode(97 + (i % 26)));
      }, 'user-edit');
      // Small delay to let CRDT sync propagate (not too long — we want char-level)
      await wait(50);
    }

    clientA.doc.off('update', updateHandler);

    // Wait for all edits to propagate to Client B
    const expectedInserted = Array.from({ length: KEYSTROKE_COUNT }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    await pollUntil(() => clientB.ytext.toString().includes(expectedInserted), 10_000);
    // Let final observer cycle settle
    await wait(800);

    // ── Step 5: Assert Y.Text edits propagated ──
    expect(clientB.ytext.toString()).toContain(expectedInserted);
    expect(clientA.ytext.toString()).toContain(expectedInserted);

    // ── Step 6: Assert rawMdxFallback Y.XmlElement identity preserved ──
    // Under the server-authoritative + always-live bridge, the
    // rawMdxFallback's inner *content* reflects the current Y.Text — it
    // is no longer frozen. But its Y.XmlElement IDENTITY must survive
    // per Precedent #10 (opaque-but-content-bearing nodes — atom:false +
    // content:'text*' means attr-change-on-every-keystroke doesn't fire
    // updateYFragment's deep-attr delete+reinsert path). A stable _item
    // lets y-prosemirror preserve the PM NodeView instance and keeps
    // RelativePositions resolving correctly.
    const fallbackBAfter = findRawMdxFallback(clientB.fragment);
    expect(fallbackBAfter).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemAfter = (fallbackBAfter! as unknown as { _item: unknown })._item;
    expect(itemAfter).toBe(itemBefore);

    // ── Step 7: Assert Client B's cursor position is stable ──
    const cursorAbsPos = Y.createAbsolutePositionFromRelativePosition(cursorRelPos, clientB.doc);
    expect(cursorAbsPos).not.toBeNull();
    // The absolute position should resolve back to the same paragraph
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(cursorAbsPos!.index).toBe(3);

    // ── Step 8: Assert Client B's XmlFragment reflects the new Y.Text ──
    // Client B sees the updated broken content (no freeze).
    // The structure around the rawMdxFallback (headings, safe paragraphs)
    // is preserved; only the rawMdxFallback's inner content updates.
    const fragmentSerializedAfter = serializeFragment(clientB.fragment);
    expect(fragmentSerializedAfter).toContain('Top heading');
    expect(fragmentSerializedAfter).toContain('Safe paragraph above');
    expect(fragmentSerializedAfter).toContain('Bottom heading');
    expect(fragmentSerializedAfter).toContain('Safe text below');
    expect(fragmentSerializedAfter).toContain(expectedInserted);
    // Quiet the unused-variable warning — fragmentSerializedBefore is kept
    // as a snapshot for future debugging if the invariant shifts again.
    void fragmentSerializedBefore;

    // ── Step 9: Assert per-keystroke updates are small ──
    // Each Y.Text char insert should produce a small CRDT update (< 200 bytes).
    // A whole-node replacement would be much larger.
    expect(updateSizes.length).toBeGreaterThanOrEqual(KEYSTROKE_COUNT);
    const maxUpdateSize = Math.max(...updateSizes);
    expect(maxUpdateSize).toBeLessThan(200);
  });

  test('rawMdxFallback visible on both clients after seeding via disk write', async () => {
    // Simpler test: verify that broken MDX seeded via file-write produces
    // rawMdxFallback visible on both connected clients.
    const brokenContent = '# Title\n\n<Callout>mismatched</Calout>\n\nParagraph.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    await pollUntil(() => clientA.ytext.toString().includes('mismatched'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('mismatched'), 10_000);
    await wait(800);

    // Both clients should have rawMdxFallback in their XmlFragment
    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    // Structured content around the fallback should be preserved
    const serializedA = serializeFragment(clientA.fragment);
    expect(serializedA).toContain('Title');
    expect(serializedA).toContain('Paragraph');
  });

  test('content-based rawMdxFallback allows concurrent edits from two clients without Y.Item churn', async () => {
    // Seed with broken MDX
    const brokenContent = 'First paragraph.\n\n<Broken>content</Mismatch>\n\nSecond paragraph.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    await pollUntil(() => clientA.ytext.toString().includes('Broken'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('Broken'), 10_000);
    await wait(800);

    // Capture initial rawMdxFallback identity on both clients
    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemA = (fallbackA! as unknown as { _item: unknown })._item;
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemB = (fallbackB! as unknown as { _item: unknown })._item;

    // Both clients make Y.Text edits simultaneously in different parts
    const posA = clientA.ytext.toString().indexOf('First paragraph.');
    const posB = clientB.ytext.toString().indexOf('Second paragraph.');

    clientA.doc.transact(() => {
      clientA.ytext.insert(posA + 'First'.length, ' EDITED');
    }, 'user-edit');

    clientB.doc.transact(() => {
      clientB.ytext.insert(posB + 'Second'.length, ' EDITED');
    }, 'user-edit');

    // Wait for bidirectional CRDT sync
    await pollUntil(
      () =>
        clientA.ytext.toString().includes('Second EDITED') &&
        clientB.ytext.toString().includes('First EDITED'),
      10_000,
    );
    await wait(800);

    // Y.Text should have both edits on both clients
    expect(clientA.ytext.toString()).toContain('First EDITED paragraph.');
    expect(clientA.ytext.toString()).toContain('Second EDITED paragraph.');
    expect(clientB.ytext.toString()).toContain('First EDITED paragraph.');
    expect(clientB.ytext.toString()).toContain('Second EDITED paragraph.');

    // rawMdxFallback identity preserved on both clients (Observer B freeze)
    const fallbackAAfter = findRawMdxFallback(clientA.fragment);
    const fallbackBAfter = findRawMdxFallback(clientB.fragment);
    expect(fallbackAAfter).not.toBeNull();
    expect(fallbackBAfter).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect((fallbackAAfter! as unknown as { _item: unknown })._item).toBe(itemA);
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect((fallbackBAfter! as unknown as { _item: unknown })._item).toBe(itemB);
  });
});
