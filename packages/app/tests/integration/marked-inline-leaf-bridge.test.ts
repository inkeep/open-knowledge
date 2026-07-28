/**
 * Marked inline leaf nodes survive the live server bridge.
 *
 * An inline *leaf* node — an inline node with no inline content, so ProseMirror
 * computes an empty mark set for it — can still carry a mark when it arrives
 * from parsed markdown: `**[[a]]**` yields a `wikiLink` node with `marks:
 * [strong]`. The PM ⇄ Y.XmlFragment conversion is the only hop on the write
 * path that can lose that mark, and losing it breaks precedent #38: the
 * fragment no longer derives from Y.Text, so the persistence write-back reports
 * a bridge-invariant violation and the doc re-derives its fragment on every
 * drain without ever converging.
 *
 * Assertions here read the settled server state rather than the conversion
 * functions directly, so they pin the user-visible outcome: what the editor
 * renders and what the server considers a healthy document.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  awaitDocQuiescence,
  createTestServer,
  getServerState,
  pollUntil,
  readTestDoc,
  type TestServer,
} from './test-harness';

let server: TestServer;
const warnLines: string[] = [];
const origWarn = console.warn;

beforeAll(async () => {
  console.warn = (...args: unknown[]) => {
    warnLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    origWarn(...args);
  };
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  console.warn = origWarn;
  await server.cleanup();
});

/**
 * Write through the real agent path and wait for the debounced persistence
 * flush, which is the write-back that runs the bridge watchdog. Polling the
 * on-disk file gates on that flush having happened rather than on a wall-clock
 * guess.
 */
async function writeAndSettle(docName: string, markdown: string) {
  await agentWriteMd(server.port, markdown, { docName, position: 'replace' });

  const doc = server.instance.hocuspocus.documents.get(docName);
  if (!doc) throw new Error(`server never opened ${docName}`);
  await awaitDocQuiescence(doc, { timeoutMs: 5000 });
  await pollUntil(() => readTestDoc(server.contentDir, docName).length > 0);

  const state = getServerState(server, docName);
  if (!state) throw new Error(`server has no state for ${docName} after the flush`);
  return state;
}

/**
 * Structured watchdog events for one document. The watchdog debounces per
 * (site, docName), so a per-test unique docName keeps one test's events from
 * suppressing another's.
 */
function bridgeEventsFor(docName: string): string[] {
  return warnLines.filter((line) => {
    if (!line.startsWith('{')) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    const event = parsed as { event?: unknown; 'doc.name'?: unknown };
    return (
      (event.event === 'bridge-invariant-violation' ||
        event.event === 'bridge-split-brain-rederive') &&
      event['doc.name'] === docName
    );
  });
}

describe('marked inline leaf nodes through the live bridge', () => {
  test('a strong-marked wikilink keeps its mark', async () => {
    const docName = `marked-inline-leaf-${randomUUID()}`;
    const state = await writeAndSettle(docName, '**[[a]]**\n');

    expect(state.ytext.toString()).toBe('**[[a]]**\n');
    expect(state.md).toBe('**[[a]]**\n');
    assertBridgeInvariant(state.ytext, state.fragment);
    expect(bridgeEventsFor(docName)).toEqual([]);
  }, 30000);

  /**
   * Inline JSX is the one inline node the shared schema already allows marks
   * on, so it isolates the conversion layer from any question of schema
   * legality.
   *
   */
  test('a strong-marked inline JSX node keeps its mark', async () => {
    const docName = `marked-inline-leaf-${randomUUID()}`;
    const state = await writeAndSettle(docName, '**<Icon />**\n');

    expect(state.ytext.toString()).toBe('**<Icon />**\n');
    expect(state.md).toBe('**<Icon />**\n');
    assertBridgeInvariant(state.ytext, state.fragment);
    expect(bridgeEventsFor(docName)).toEqual([]);
  }, 30000);

  /**
   * Control: marks on text runs already round-trip, and an unmarked leaf has
   * no mark to lose. Both travel the same path as the cases above, so a
   * failure here would mean the harness or the assertions are wrong rather
   * than the bridge.
   *
   */
  test('marked text and an unmarked wikilink are unaffected', async () => {
    const docName = `marked-inline-leaf-control-${randomUUID()}`;
    const state = await writeAndSettle(docName, '**bold text**\n\n[[a]]\n');

    expect(state.ytext.toString()).toBe('**bold text**\n\n[[a]]\n');
    expect(state.md).toBe('**bold text**\n\n[[a]]\n');
    assertBridgeInvariant(state.ytext, state.fragment);
    expect(bridgeEventsFor(docName)).toEqual([]);
  }, 30000);
});
