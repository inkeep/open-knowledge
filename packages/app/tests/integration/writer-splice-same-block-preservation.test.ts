import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  applyProjectionEdit,
  createTestClients,
  createTestServer,
  pollUntil,
  projectionPosAfter,
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

interface SpliceCase {
  name: string;
  seed: string;
  editMarker: string;
  expected: string;
  covers: string;
}

async function runSpliceCase(c: SpliceCase): Promise<{ texts: string[]; clients: TestClient[] }> {
  const docName = `splice-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
  });
  try {
    await agentWriteMd(server.port, c.seed, { docName, position: 'replace' });
    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes(c.editMarker), 5000);
    }
    await wait(400);

    applyProjectionEdit(clients[0], (tr, doc) =>
      tr.insertText(' EDITWORD', projectionPosAfter(doc, c.editMarker)),
    );

    for (const client of clients) {
      await pollUntil(() => client.ytext.toString().includes('EDITWORD'), 5000);
    }
    await wait(600);

    const texts = clients.map((cl) => cl.ytext.toString());
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
    name: 'CHARACTERIZATION: editing one list item re-serializes the list and collapses an interior blank run',
    seed: '- item one\n\n  para in item\n\n\n  wide gap para\n- item two editable\n',
    editMarker: 'item two editable',
    expected: '- item one\n\n  para in item\n\n  wide gap para\n- item two editable EDITWORD\n',
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

describe('same-block byte preservation through the projection splice', () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const { texts } = await runSpliceCase(c);
      expect(texts[0]).toBe(c.expected);
      expect(texts[1]).toBe(texts[0]);
    }, 25_000);
  }

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
