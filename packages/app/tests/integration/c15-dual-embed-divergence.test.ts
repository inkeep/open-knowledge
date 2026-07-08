/**
 * C15: Dual `html preview` embeds under a divergence/reconnect window.
 *
 * The bug class: a doc with two `html preview` `<script>` embeds
 * (the second declaring `const DATA={…}`) corrupted the second embed's script
 * head (`const`→`{onst`) and triplicated the body under multi-replica merges.
 * This drives that construct at integration fidelity — two real clients editing
 * across a pause/resume divergence window — and asserts the embeds survive
 * intact: scripts still parse, the brace-injection signature never appears, the
 * `const DATA=` head is preserved, and the doc stays within a byte budget.
 *
 * NOTE: the bug's PRODUCTION trigger is a knowingly-deferred
 * embed-root-fix concern. This is the test-side observability of
 * the construct (an approximation of OS-process duplicate-server divergence via
 * the two-client harness), not a production mitigation.
 *
 * Per-test docName isolation; client lifecycle in try/finally.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  assertBridgeInvariant,
  createTestClients,
  createTestServer,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// Two `html preview` embeds; the second declares `const DATA={…}` — the M-6955
// brace-injection target. Each script carries a unique anchor.
const DUAL_EMBED_SEED = [
  '# C15 chart doc',
  '',
  '```html h=400px preview',
  '<div id="first"></div>',
  '<script>',
  'const FIRST = "C15-FIRST-SCRIPT";',
  'document.getElementById("first").textContent = FIRST;',
  '</script>',
  '```',
  '',
  'Prose between the two embeds.',
  '',
  '```html h=640px preview',
  '<div id="second"></div>',
  '<script>',
  'const DATA = {"label": "C15-SECOND-SCRIPT", "points": [[1, 2], [3, 4]]};',
  'document.getElementById("second").textContent = JSON.stringify(DATA);',
  '</script>',
  '```',
  '',
].join('\n');

const BRACE_INJECTION_RE = /\{onst|\{on\{|\{ons\{|\{var\{/;

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

function extractScriptBodies(doc: string): string[] {
  const bodies: string[] = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null = re.exec(doc);
  while (m !== null) {
    const body = (m[1] ?? '').trim();
    if (body.length > 0) bodies.push(body);
    m = re.exec(doc);
  }
  return bodies;
}

// Real JS-syntax validation. `new Function()` parses eagerly and throws on a
// syntax error under both Bun and Node; `new vm.Script()` compiles lazily under
// Bun and never throws, which would silently make this oracle vacuous (it would
// pass even on the brace-corrupted `{onst DATA=` head). Mirrors `jsParses` in
// packages/core/src/markdown/embed-script-fidelity.test.ts.
function jsParses(code: string): boolean {
  try {
    new Function(code);
    return true;
  } catch {
    return false;
  }
}

async function awaitAllContain(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes(marker), 5000);
    }
  }
  await wait(600);
}

describe('C15: dual html-preview embeds under divergence', () => {
  test('embeds survive concurrent edits + reconnect — scripts intact, no injection, bounded', async () => {
    const docName = `c15-dual-embed-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      await agentWriteMd(server.port, DUAL_EMBED_SEED, { docName, position: 'replace' });
      await awaitAllContain(clients, ['C15-FIRST-SCRIPT', 'C15-SECOND-SCRIPT']);

      // Divergence window: client 0 stops syncing, both edit concurrently.
      clients[0].pauseSync();
      appendParagraph(clients[0], 'C15-WYSIWYG-A');
      appendParagraph(clients[1], 'C15-WYSIWYG-B');
      await wait(300);
      clients[0].resumeSync();
      await awaitAllContain(clients, [
        'C15-FIRST-SCRIPT',
        'C15-SECOND-SCRIPT',
        'C15-WYSIWYG-A',
        'C15-WYSIWYG-B',
      ]);

      const ytexts = clients.map((c) => c.ytext.toString());
      expect(ytexts[1]).toBe(ytexts[0]);
      for (const client of clients) assertBridgeInvariant(client.ytext, client.fragment);

      const converged = ytexts[0];

      // embed integrity: no brace-injection signature, the `const DATA=`
      // head is preserved verbatim, and every extracted script still parses.
      expect(BRACE_INJECTION_RE.test(converged)).toBe(false);
      expect(converged).toContain('const DATA = {');
      const scripts = extractScriptBodies(converged);
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const body of scripts) {
        expect(jsParses(body)).toBe(true);
      }

      // No duplication of either embed (the triplication signature).
      for (const m of ['C15-FIRST-SCRIPT', 'C15-SECOND-SCRIPT']) {
        expect(converged.split(m).length - 1).toBe(1);
      }

      // byte budget: bounded by the authored input.
      const authoredBytes =
        Buffer.byteLength(DUAL_EMBED_SEED) + Buffer.byteLength('C15-WYSIWYG-A C15-WYSIWYG-B');
      expect(Buffer.byteLength(converged)).toBeLessThanOrEqual(authoredBytes * 3);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});

const FENCE = '`'.repeat(3);

describe('QA canary — html-preview <script> embed under concurrent source edits', () => {
  /**
   * A single large html-preview embed with a <script> body; two peers edit
   * distinct prose regions concurrently. The embed must survive as exactly one
   * copy — no triplication, no astral-brace injection into the script head.
   *
   */
  test('concurrent edits around an html-preview <script> embed do not duplicate or brace-inject', async () => {
    const docName = `canary-embed-${crypto.randomUUID()}`;
    const seed = [
      '# Demo',
      '',
      'Para A.',
      '',
      'Para B.',
      '',
      `${FENCE}html`,
      '<div id="app"></div>',
      '<script>',
      'const greeting = "hello world";',
      'document.getElementById("app").textContent = greeting;',
      '</script>',
      FENCE,
      '',
    ].join('\n');
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const clients = await createTestClients(server.port, { count: 2, docName });
    try {
      await assertAllConverged(clients, { timeout: 5000 });
      // Concurrent source-side edits in distinct prose regions (W2 path per peer).
      const a = clients[0].ytext;
      const b = clients[1].ytext;
      const ia = a.toString().indexOf('Para A.') + 'Para A.'.length;
      clients[0].doc.transact(() => a.insert(ia, ' edit-A'));
      const ib = b.toString().indexOf('Para B.') + 'Para B.'.length;
      clients[1].doc.transact(() => b.insert(ib, ' edit-B'));
      await assertAllConverged(clients, { timeout: 5000 });

      const after = clients[0].ytext.toString();
      expect(after).toContain('edit-A');
      expect(after).toContain('edit-B');
      expect((after.match(/<script>/g) ?? []).length).toBe(1); // no triplication
      expect((after.match(/const greeting/g) ?? []).length).toBe(1);
      expect(after).not.toContain('{onst'); // no astral-brace injection
      expect(after).not.toContain('{ons{');
      expect(after.length).toBeLessThan(seed.length + 64); // no growth blow-up
    } finally {
      await Promise.all(clients.map((c) => c.cleanup()));
    }
  }, 30_000);
});
