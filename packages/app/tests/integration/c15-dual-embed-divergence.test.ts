
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
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

      expect(BRACE_INJECTION_RE.test(converged)).toBe(false);
      expect(converged).toContain('const DATA = {');
      const scripts = extractScriptBodies(converged);
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const body of scripts) {
        expect(jsParses(body)).toBe(true);
      }

      for (const m of ['C15-FIRST-SCRIPT', 'C15-SECOND-SCRIPT']) {
        expect(converged.split(m).length - 1).toBe(1);
      }

      const authoredBytes =
        Buffer.byteLength(DUAL_EMBED_SEED) + Buffer.byteLength('C15-WYSIWYG-A C15-WYSIWYG-B');
      expect(Buffer.byteLength(converged)).toBeLessThanOrEqual(authoredBytes * 3);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
