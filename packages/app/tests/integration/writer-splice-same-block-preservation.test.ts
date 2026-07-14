/**
 * Same-block byte preservation through Observer A's map-driven splice.
 *
 * Contract (per-write-path fidelity): the WYSIWYG serialize path is
 * construct-canonical — it may canonicalize the construct the human actually
 * edited, but agent-authored bytes of constructs the human did NOT touch must
 * survive, including constructs inside the SAME top-level block as the edit
 * and constructs whose byte-form does not round-trip through parse+serialize
 * (blockquote lazy continuation, blank-line runs inside list items, tight
 * ATX-heading adjacency).
 *
 * Multi-client topology per the observer-bridge coverage rule: the edit is
 * authored on client A; assertions run on BOTH clients after convergence,
 * so remote-peer divergence is covered, not just local echo.
 */

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

function findXmlTextContaining(
  node: Y.XmlFragment | Y.XmlElement,
  marker: string,
): Y.XmlText | null {
  const len = node.length;
  for (let i = 0; i < len; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) {
      if (child.toString().includes(marker)) return child;
    } else if (child instanceof Y.XmlElement) {
      const found = findXmlTextContaining(child, marker);
      if (found) return found;
    }
  }
  return null;
}

interface SpliceCase {
  name: string;
  seed: string;
  /** text content of the span the simulated human edits (gets " EDITWORD" appended) */
  editMarker: string;
  /** full expected Y.Text bytes after the edit settles */
  expected: string;
  covers: string;
}

/**
 * Seed via the agent path (bytes land verbatim by construction), append
 * " EDITWORD" to the edit-target span through client A's XmlFragment (the
 * WYSIWYG write surface), await convergence, and return both clients' Y.Text.
 */
async function runSpliceCase(c: SpliceCase): Promise<{ texts: string[]; clients: TestClient[] }> {
  const docName = `splice-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    perClientOptions: { skipInvariantWatcher: true },
  });
  try {
    await agentWriteMd(server.port, c.seed, { docName, position: 'replace' });
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes(c.editMarker), 5000);
    }
    await wait(400);

    const target = findXmlTextContaining(clients[0].fragment, c.editMarker);
    if (!target) throw new Error(`edit marker not found in fragment: ${c.editMarker}`);
    target.insert(target.length, ' EDITWORD');

    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes('EDITWORD'), 5000);
    }
    await wait(600);

    const texts = clients.map((cl) => cl.ytext.toString());
    for (const client of clients) {
      assertBridgeInvariant(client.ytext, client.fragment);
    }
    return { texts, clients };
  } finally {
    for (const cl of clients) await cl.cleanup();
  }
}

const CASES: SpliceCase[] = [
  {
    name: 'lazy continuation survives an edit to a sibling paragraph in the SAME blockquote',
    seed: '> lazy first line\nlazy continuation stays\n>\n> editable second para\n',
    editMarker: 'editable second para',
    expected: '> lazy first line\nlazy continuation stays\n>\n> editable second para EDITWORD\n',
    covers: 'blockquote',
  },
  {
    name: 'lazy continuation survives an edit to a DIFFERENT top-level block',
    seed: '> lazy ctrl line\nlazy ctrl continuation\n\nSeparate ctrl paragraph.\n',
    editMarker: 'Separate ctrl paragraph.',
    expected: '> lazy ctrl line\nlazy ctrl continuation\n\nSeparate ctrl paragraph. EDITWORD\n',
    covers: 'blockquote',
  },
  {
    name: 'multi-blank run inside a list item survives an edit to a sibling item in the SAME list',
    seed: '- item one\n\n  para in item\n\n\n  wide gap para\n- item two editable\n',
    editMarker: 'item two editable',
    expected: '- item one\n\n  para in item\n\n\n  wide gap para\n- item two editable EDITWORD\n',
    covers: 'list-bullet-dash, list-item',
  },
  {
    name: 'tight ATX heading adjacency survives an edit to the adjacent paragraph',
    seed: '## TightHead\nTight paragraph editable.\n',
    editMarker: 'Tight paragraph editable.',
    expected: '## TightHead\nTight paragraph editable. EDITWORD\n',
    covers: 'heading-atx-2',
  },
];

describe('same-block byte preservation through Observer A', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const { texts } = await runSpliceCase(c);
      expect(texts[0]).toBe(c.expected);
      expect(texts[1]).toBe(texts[0]);
    }, 25_000);
  }

  /**
   * Control pins: attr-covered cosmetic forms already survive same-block
   * edits via source-form capture/replay. These pin the behavior the fix
   * must not regress.
   *
   */
  test('attr-covered cosmetic forms survive same-block edits (control pins)', async () => {
    const cases: Array<Omit<SpliceCase, 'expected' | 'covers'> & { untouched: string[] }> = [
      {
        name: 'star bullets',
        seed: '* alpha item\n* beta item\n',
        editMarker: 'alpha item',
        untouched: ['* beta item'],
      },
      {
        name: 'paren ordered',
        seed: '1) first thing\n2) second thing\n',
        editMarker: 'first thing',
        untouched: ['2) second thing'],
      },
      {
        name: 'underscore emphasis sibling span',
        seed: 'Lead sentence here. Tail with _underscore emphasis_ kept.\n',
        editMarker: 'kept.',
        untouched: ['_underscore emphasis_'],
      },
      {
        name: 'padded table cells',
        seed: '| Name    | Value   |\n| ------- | ------- |\n| rowone  | 111     |\n| rowtwo  | 222     |\n',
        editMarker: 'rowone',
        untouched: ['| rowtwo  | 222     |'],
      },
    ];
    for (const c of cases) {
      const { texts } = await runSpliceCase({ ...c, expected: '', covers: '' });
      for (const bytes of c.untouched) {
        expect(texts[0]).toContain(bytes);
      }
      expect(texts[0]).toContain('EDITWORD');
      expect(texts[1]).toBe(texts[0]);
    }
  }, 60_000);
});
