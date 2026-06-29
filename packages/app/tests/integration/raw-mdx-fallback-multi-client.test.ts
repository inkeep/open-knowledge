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

function findRawMdxFallback(fragment: Y.XmlFragment): Y.XmlElement | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'rawMdxFallback') {
      return child;
    }
  }
  return null;
}

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

function getFirstXmlText(el: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) {
      return child;
    }
  }
  return null;
}

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
    const brokenContent =
      '# Top heading\n\nSafe paragraph above.\n\n<Foo>broken content</Bar>\n\n## Bottom heading\n\nSafe text below.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    await pollUntil(() => clientA.ytext.toString().includes('broken content'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('broken content'), 10_000);
    await wait(800);

    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemBefore = (fallbackB! as unknown as { _item: unknown })._item;
    expect(itemBefore).toBeTruthy();

    const fragmentSerializedBefore = serializeFragment(clientB.fragment);

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

    const brokenTextStart = clientA.ytext.toString().indexOf('<Foo>broken content</Bar>');
    expect(brokenTextStart).toBeGreaterThanOrEqual(0);

    const insertPos = brokenTextStart + '<Foo>broken content'.length;

    const KEYSTROKE_COUNT = 20;
    const updateSizes: number[] = [];

    const updateHandler = (update: Uint8Array) => {
      updateSizes.push(update.byteLength);
    };
    clientA.doc.on('update', updateHandler);

    for (let i = 0; i < KEYSTROKE_COUNT; i++) {
      clientA.doc.transact(() => {
        clientA.ytext.insert(insertPos + i, String.fromCharCode(97 + (i % 26)));
      }, 'user-edit');
      await wait(50);
    }

    clientA.doc.off('update', updateHandler);

    const expectedInserted = Array.from({ length: KEYSTROKE_COUNT }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    await pollUntil(() => clientB.ytext.toString().includes(expectedInserted), 10_000);
    await wait(800);

    expect(clientB.ytext.toString()).toContain(expectedInserted);
    expect(clientA.ytext.toString()).toContain(expectedInserted);

    const fallbackBAfter = findRawMdxFallback(clientB.fragment);
    expect(fallbackBAfter).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemAfter = (fallbackBAfter! as unknown as { _item: unknown })._item;
    expect(itemAfter).toBe(itemBefore);

    const cursorAbsPos = Y.createAbsolutePositionFromRelativePosition(cursorRelPos, clientB.doc);
    expect(cursorAbsPos).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: checked above
    expect(cursorAbsPos!.index).toBe(3);

    const fragmentSerializedAfter = serializeFragment(clientB.fragment);
    expect(fragmentSerializedAfter).toContain('Top heading');
    expect(fragmentSerializedAfter).toContain('Safe paragraph above');
    expect(fragmentSerializedAfter).toContain('Bottom heading');
    expect(fragmentSerializedAfter).toContain('Safe text below');
    expect(fragmentSerializedAfter).toContain(expectedInserted);
    void fragmentSerializedBefore;

    expect(updateSizes.length).toBeGreaterThanOrEqual(KEYSTROKE_COUNT);
    const maxUpdateSize = Math.max(...updateSizes);
    expect(maxUpdateSize).toBeLessThan(200);
  });

  test('rawMdxFallback visible on both clients after seeding via disk write', async () => {
    const brokenContent = '# Title\n\n<Callout>mismatched</Calout>\n\nParagraph.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    await pollUntil(() => clientA.ytext.toString().includes('mismatched'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('mismatched'), 10_000);
    await wait(800);

    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    const serializedA = serializeFragment(clientA.fragment);
    expect(serializedA).toContain('Title');
    expect(serializedA).toContain('Paragraph');
  });

  test('content-based rawMdxFallback allows concurrent edits from two clients without Y.Item churn', async () => {
    const brokenContent = 'First paragraph.\n\n<Broken>content</Mismatch>\n\nSecond paragraph.\n';
    writeFileSync(join(server.contentDir, 'test-doc.md'), brokenContent, 'utf-8');

    await pollUntil(() => clientA.ytext.toString().includes('Broken'), 10_000);
    await pollUntil(() => clientB.ytext.toString().includes('Broken'), 10_000);
    await wait(800);

    const fallbackA = findRawMdxFallback(clientA.fragment);
    const fallbackB = findRawMdxFallback(clientB.fragment);
    expect(fallbackA).not.toBeNull();
    expect(fallbackB).not.toBeNull();

    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemA = (fallbackA! as unknown as { _item: unknown })._item;
    // biome-ignore lint/style/noNonNullAssertion: checked above
    const itemB = (fallbackB! as unknown as { _item: unknown })._item;

    const posA = clientA.ytext.toString().indexOf('First paragraph.');
    const posB = clientB.ytext.toString().indexOf('Second paragraph.');

    clientA.doc.transact(() => {
      clientA.ytext.insert(posA + 'First'.length, ' EDITED');
    }, 'user-edit');

    clientB.doc.transact(() => {
      clientB.ytext.insert(posB + 'Second'.length, ' EDITED');
    }, 'user-edit');

    await pollUntil(
      () =>
        clientA.ytext.toString().includes('Second EDITED') &&
        clientB.ytext.toString().includes('First EDITED'),
      10_000,
    );
    await wait(800);

    expect(clientA.ytext.toString()).toContain('First EDITED paragraph.');
    expect(clientA.ytext.toString()).toContain('Second EDITED paragraph.');
    expect(clientB.ytext.toString()).toContain('First EDITED paragraph.');
    expect(clientB.ytext.toString()).toContain('Second EDITED paragraph.');

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
