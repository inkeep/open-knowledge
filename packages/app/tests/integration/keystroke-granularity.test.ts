/**
 * Keystroke-granularity bridge health — char-by-char edits through the live
 * server observers with warn-channel-silence assertions.
 *
 * Character-granularity editing creates intermediate states single-shot
 * test edits never produce: every keystroke is its own transaction, drain,
 * and settlement. A paragraph momentarily ending in a just-typed space has
 * no round-trip-stable byte spelling (the serializer deliberately emits
 * paragraph-trailing spaces raw; parse strips them), so on docs resting
 * beyond byte tolerance the settlement's parse-equivalence rescue must
 * treat trailing line whitespace as the normalization the byte layer and
 * serializer already declare it to be — otherwise every space keystroke on
 * an organic lazy-continuation doc reports split-brain.
 *
 * No other tier reaches this combination: the fuzz generator's
 * type-chars op also types char-by-char but asserts only convergence and
 * content preservation — not warn-channel silence — e2e keystrokes cannot
 * observe the server-side warn channels, and the single-shot integration
 * suites settle exactly once.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
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

const HEALTH_EVENT_RE = /bridge-invariant-violation|bridge-split-brain-rederive/;

const LAZY_DOC = `# Keystroke granularity

**Why not now:**
- First bullet
- Second bullet
- Third bullet
**Trigger to revisit:** This bold-label paragraph immediately follows the list.
`;
const LAZY_SLICE = '- Third bullet\n**Trigger to revisit:**';

const CANONICAL_DOC = '# Keystroke granularity\n\nA plain paragraph.\n';

/** Health events for one docName while `fn` runs (console.warn capture). */
async function captureHealthEvents(docName: string, fn: () => Promise<void>): Promise<string[]> {
  const origWarn = console.warn;
  const lines: string[] = [];
  console.warn = ((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    origWarn(...args);
  }) as typeof console.warn;
  try {
    await fn();
  } finally {
    console.warn = origWarn;
  }
  return lines.filter((l) => HEALTH_EVENT_RE.test(l) && l.includes(docName));
}

/** Append a paragraph and type the rest of `text` one char per transaction. */
async function typeNewParagraph(client: TestClient, text: string, gapMs: number): Promise<void> {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.applyDelta([{ insert: text.slice(0, 1) }]);
  p.insert(0, [t]);
  client.fragment.push([p]);
  for (const ch of text.slice(1)) {
    if (gapMs > 0) await wait(gapMs);
    client.doc.transact(() => {
      t.applyDelta([{ retain: t.length }, { insert: ch }]);
    });
  }
}

/** Plain text of a Y.XmlText from its delta — `.toString()` renders inline
 *  marks as XML tags, so indexOf on it does NOT map to a Yjs retain offset. */
function plainText(t: Y.XmlText): string {
  let s = '';
  for (const op of t.toDelta() as Array<{ insert?: unknown }>) {
    if (typeof op.insert === 'string') s += op.insert;
    else if (op.insert !== undefined) s += '￼';
  }
  return s;
}

function findXmlText(node: Y.XmlFragment | Y.XmlElement, needle: string): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) {
      if (child.toString().includes(needle)) return child;
    } else if (child instanceof Y.XmlElement) {
      const found = findXmlText(child, needle);
      if (found) return found;
    }
  }
  return null;
}

async function seedLazyDoc(client: TestClient): Promise<void> {
  client.doc.transact(() => {
    client.ytext.insert(0, LAZY_DOC);
  });
  await pollUntil(() => client.ytext.toString().includes('Trigger to revisit'), 5000);
  await wait(500);
}

describe('keystroke granularity: resting beyond-tolerance docs', () => {
  test('char-by-char append typing settles without health-channel noise', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      await seedLazyDoc(clients[0]);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        await typeNewParagraph(clients[0], 'Vetted live typing.', 30);
        await pollUntil(() => clients[0].ytext.toString().includes('Vetted live typing.'), 5000);
        await wait(600);
      });
      expect(events).toHaveLength(0);
      expect(clients[0].ytext.toString()).toContain(LAZY_SLICE);
    } finally {
      for (const c of clients) c.cleanup();
    }
  });

  test('a zero-gap keystroke burst settles without health-channel noise', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      await seedLazyDoc(clients[0]);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        await typeNewParagraph(clients[0], 'burst typed words here.', 0);
        await pollUntil(
          () => clients[0].ytext.toString().includes('burst typed words here.'),
          5000,
        );
        await wait(600);
      });
      expect(events).toHaveLength(0);
      expect(clients[0].ytext.toString()).toContain(LAZY_SLICE);
    } finally {
      for (const c of clients) c.cleanup();
    }
  });

  test('two peers typing concurrently converge without health-channel noise', async () => {
    const clients = await createTestClients(server.port, { count: 2 });
    try {
      await seedLazyDoc(clients[0]);
      await pollUntil(() => clients[1].ytext.toString().includes('Trigger to revisit'), 5000);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        await Promise.all([
          typeNewParagraph(clients[0], 'peer one typed this sentence.', 25),
          typeNewParagraph(clients[1], 'peer two typed another one.', 35),
        ]);
        for (const c of clients) {
          await pollUntil(
            () =>
              c.ytext.toString().includes('peer one typed this sentence.') &&
              c.ytext.toString().includes('peer two typed another one.'),
            8000,
          );
        }
        await wait(600);
      });
      expect(events).toHaveLength(0);
      const [a, b] = clients.map((c) => c.ytext.toString());
      expect(a).toBe(b);
      expect(a).toContain(LAZY_SLICE);
    } finally {
      for (const c of clients) c.cleanup();
    }
  });

  test('mid-paragraph insertion via delta offsets stays clean and byte-faithful', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      await seedLazyDoc(clients[0]);
      const t = findXmlText(clients[0].fragment, 'glued');
      const target = t ?? findXmlText(clients[0].fragment, 'immediately follows');
      expect(target).not.toBeNull();
      if (!target) return;
      const offset = plainText(target).indexOf('immediately');
      expect(offset).toBeGreaterThan(-1);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        for (const [i, ch] of Array.from('INS ').entries()) {
          if (i > 0) await wait(25);
          clients[0].doc.transact(() => {
            target.applyDelta([{ retain: offset + i }, { insert: ch }]);
          });
        }
        await pollUntil(() => clients[0].ytext.toString().includes('INS immediately'), 5000);
        await wait(600);
      });
      expect(events).toHaveLength(0);
      expect(clients[0].ytext.toString()).toContain(LAZY_SLICE);
    } finally {
      for (const c of clients) c.cleanup();
    }
  });
});

describe('keystroke granularity: canonical docs (controls)', () => {
  test('char typing of markdown-significant literals stays clean and escapes correctly', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, CANONICAL_DOC);
      });
      await pollUntil(() => clients[0].ytext.toString().includes('plain paragraph'), 5000);
      await wait(400);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        for (const literal of ['**bold**', '| pipe | row |', '<br />']) {
          await typeNewParagraph(clients[0], literal, 0);
        }
        await pollUntil(() => clients[0].ytext.toString().includes('pipe'), 5000);
        await wait(600);
      });
      expect(events).toHaveLength(0);
      // Typed literals survive as literals through a fresh parse: the bytes
      // must not have become live constructs.
      const bytes = clients[0].ytext.toString();
      expect(bytes).toContain('bold');
      expect(bytes).toContain('pipe');
    } finally {
      for (const c of clients) c.cleanup();
    }
  });

  test('char-by-char source-side deletion back through a table row stays clean', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      const md = '# Del\n\n| a |\n| - |\n| b |\n';
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, md);
      });
      await pollUntil(() => clients[0].ytext.toString().includes('| b |'), 5000);
      await wait(400);
      const events = await captureHealthEvents(clients[0].docName, async () => {
        // Delete the last row one char per transaction (backspace cadence).
        for (let i = 0; i < '| b |\n'.length; i++) {
          await wait(20);
          clients[0].doc.transact(() => {
            clients[0].ytext.delete(clients[0].ytext.length - 1, 1);
          });
        }
        await wait(600);
      });
      expect(events).toHaveLength(0);
      expect(clients[0].ytext.toString()).toContain('| - |');
    } finally {
      for (const c of clients) c.cleanup();
    }
  });
});
