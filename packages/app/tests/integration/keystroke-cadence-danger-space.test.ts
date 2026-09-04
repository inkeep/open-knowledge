import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  awaitDocQuiescence,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  mdManager,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

const CALLOUT_SEED = ['<Callout type="info">', '', 'Note:', '', '</Callout>', ''].join('\n');
const TABLE_SEED = ['| Head |', '| --- |', '| seed |', ''].join('\n');
const TWO_CALLOUTS = [
  '<Callout type="info">',
  '',
  'AAA',
  '',
  '</Callout>',
  '',
  '<Callout type="warning">',
  '',
  'BBB',
  '',
  '</Callout>',
  '',
].join('\n');

const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/;
const KEYSTROKE_TEST_TIMEOUT_MS = 30_000;

type PmNodeJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNodeJson[];
  marks?: unknown[];
};

function currentTree(client: TestClient): PmNodeJson {
  return yXmlFragmentToProseMirrorRootNode(client.fragment, schema).toJSON() as PmNodeJson;
}

function firstTextNode(node: PmNodeJson): PmNodeJson | undefined {
  if (typeof node.text === 'string') return node;
  for (const child of node.content ?? []) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return undefined;
}

function subtreeText(node: PmNodeJson): string {
  let acc = node.text ?? '';
  for (const child of node.content ?? []) acc += subtreeText(child);
  return acc;
}

const isCallout = (n: PmNodeJson): boolean =>
  n.type === 'jsxComponent' && n.attrs?.componentName === 'Callout';
const isBodyCell = (n: PmNodeJson): boolean => n.type === 'tableCell';

function editInterior(
  tree: PmNodeJson,
  isContainer: (n: PmNodeJson) => boolean,
  whenFirstText: (t: string) => boolean,
  nextText: string,
  flipDirty: boolean,
): PmNodeJson {
  const next = structuredClone(tree);
  let done = false;
  const walk = (node: PmNodeJson): void => {
    if (done) return;
    if (isContainer(node)) {
      const leaf = firstTextNode(node);
      if (leaf && whenFirstText(leaf.text as string)) {
        leaf.text = nextText;
        if (flipDirty) node.attrs = { ...node.attrs, sourceDirty: true };
        done = true;
        return;
      }
    }
    node.content?.forEach(walk);
  };
  walk(next);
  if (!done) throw new Error('editInterior: no matching container found in the tree');
  return next;
}

function commitFragment(client: TestClient, tree: PmNodeJson): void {
  const pmNode = schema.nodeFromJSON(tree);
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function reparsedInteriorText(source: string, isTarget: (n: PmNodeJson) => boolean): string {
  const json = mdManager.parseWithFallback(source) as PmNodeJson;
  let text = '';
  let found = false;
  const walk = (n: PmNodeJson): void => {
    if (found) return;
    if (isTarget(n)) {
      text = subtreeText(n);
      found = true;
      return;
    }
    n.content?.forEach(walk);
  };
  walk(json);
  return text;
}

const firstBodyCellText = (source: string): string => reparsedInteriorText(source, isBodyCell);
const firstCalloutInteriorText = (source: string): string =>
  reparsedInteriorText(source, isCallout);

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function serverText(docName: string): string {
  return getServerState(server, docName)?.ytext.toString() ?? '';
}

async function pollFor(predicate: () => boolean, budgetMs = 6_000, stepMs = 40): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (predicate()) return true;
    await wait(stepMs);
  }
  return predicate();
}

async function expectPersisted(
  docName: string,
  predicate: (s: string) => boolean,
  ctx: string,
): Promise<void> {
  const ok = await pollFor(() => predicate(serverText(docName)));
  if (!ok) {
    throw new Error(
      `${ctx}\n  survival oracle unmet within budget — the drain never persisted the byte ` +
        `(a producer-guard abort or a mangled re-derivation).\n  current server bytes: ${JSON.stringify(
          serverText(docName),
        )}`,
    );
  }
}

describe('keystroke-cadence fidelity — registered danger-space, per-drain guard + freshness', () => {
  test(
    'Callout interior, no dirty flip: freshness re-derives every keystroke, guard silent',
    async () => {
      const docName = `keystroke-callout-noflip-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, CALLOUT_SEED, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        await awaitDocQuiescence(client.doc);
        expect(serverText(docName)).toContain('Note:');

        const typed = ' incident summary';
        let interior = 'Note:';
        for (let i = 0; i < typed.length; i++) {
          interior += typed[i];
          commitFragment(
            client,
            editInterior(
              currentTree(client),
              isCallout,
              (t) => t.startsWith('Note:'),
              interior,
              false,
            ),
          );
          await awaitDocQuiescence(client.doc);
          const prefix = interior;
          await expectPersisted(
            docName,
            (s) => normalizeWs(firstCalloutInteriorText(s)) === normalizeWs(prefix),
            `Callout no-flip keystroke #${i + 1} (${JSON.stringify(typed[i])}) → interior ${JSON.stringify(prefix)}`,
          );
          const s = serverText(docName);
          expect(s.match(/<Callout\b/g)).toHaveLength(1);
          expect(s.match(/<\/Callout>/g)).toHaveLength(1);
          expect(s).not.toMatch(INDENTED_CALLOUT);
        }

        const final = serverText(docName);
        expect(normalizeWs(firstCalloutInteriorText(final))).toBe('Note: incident summary');
        expect(final).toContain('type="info"');
      } finally {
        await client.cleanup();
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );

  test(
    'Callout interior, dirty flip: guard stays silent across the burst',
    async () => {
      const docName = `keystroke-callout-flip-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, CALLOUT_SEED, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        await awaitDocQuiescence(client.doc);
        const typed = ' urgent';
        let interior = 'Note:';
        for (let i = 0; i < typed.length; i++) {
          interior += typed[i];
          commitFragment(
            client,
            editInterior(
              currentTree(client),
              isCallout,
              (t) => t.startsWith('Note:'),
              interior,
              true,
            ),
          );
          await awaitDocQuiescence(client.doc);
          const prefix = interior;
          await expectPersisted(
            docName,
            (s) => normalizeWs(firstCalloutInteriorText(s)) === normalizeWs(prefix),
            `Callout flip keystroke #${i + 1} → interior ${JSON.stringify(prefix)}`,
          );
          expect(serverText(docName).match(/<Callout\b/g)).toHaveLength(1);
        }
        const final = serverText(docName);
        expect(normalizeWs(firstCalloutInteriorText(final))).toBe('Note: urgent');
        expect(final).toContain('type="info"');
        expect(final).not.toMatch(INDENTED_CALLOUT);
      } finally {
        await client.cleanup();
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );

  test(
    'Table cell: escaping-hot characters typed char-by-char survive, guard silent',
    async () => {
      const docName = `keystroke-tablecell-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, TABLE_SEED, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        await awaitDocQuiescence(client.doc);
        expect(firstBodyCellText(serverText(docName))).toBe('seed');

        const typed = 'a|b*c`d';
        let cell = 'seed';
        for (let i = 0; i < typed.length; i++) {
          cell += typed[i];
          commitFragment(
            client,
            editInterior(currentTree(client), isBodyCell, (t) => t.startsWith('seed'), cell, false),
          );
          await awaitDocQuiescence(client.doc);
          const expected = cell;
          await expectPersisted(
            docName,
            (s) => firstBodyCellText(s) === expected,
            `Table cell keystroke #${i + 1} (${JSON.stringify(typed[i])}) → cell ${JSON.stringify(expected)}`,
          );
          expect(serverText(docName)).toMatch(/\|\s*-+\s*\|/);
        }
        expect(firstBodyCellText(serverText(docName))).toBe('seeda|b*c`d');
      } finally {
        await client.cleanup();
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );

  test(
    'Callout interior: grow, backspace-correct, regrow — no guard fire on any transient',
    async () => {
      const docName = `keystroke-correct-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, CALLOUT_SEED, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        await awaitDocQuiescence(client.doc);

        const states = [
          'Note:a',
          'Note:ab',
          'Note:abc',
          'Note:ab',
          'Note:a',
          'Note:aX',
          'Note:aXY',
          'Note:aXYZ',
        ];
        for (let i = 0; i < states.length; i++) {
          const interior = states[i];
          commitFragment(
            client,
            editInterior(
              currentTree(client),
              isCallout,
              (t) => t.startsWith('Note:'),
              interior,
              false,
            ),
          );
          await awaitDocQuiescence(client.doc);
          await expectPersisted(
            docName,
            (s) => normalizeWs(firstCalloutInteriorText(s)) === normalizeWs(interior),
            `correct step #${i + 1} → interior ${JSON.stringify(interior)}`,
          );
          const s = serverText(docName);
          expect(s.match(/<Callout\b/g)).toHaveLength(1);
          expect(s).not.toMatch(INDENTED_CALLOUT);
        }
        expect(normalizeWs(firstCalloutInteriorText(serverText(docName)))).toBe('Note:aXYZ');
      } finally {
        await client.cleanup();
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );

  test(
    'sibling pristine Callout stays byte-stable while the other is typed into; peers converge',
    async () => {
      const docName = `keystroke-sibling-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, TWO_CALLOUTS, { docName, position: 'replace' });
      await wait(300);
      const [a, b] = await createTestClients(server.port, { count: 2, docName });
      try {
        await awaitDocQuiescence(a.doc);
        await awaitDocQuiescence(b.doc);
        await assertAllConverged([a, b]);

        const seedText = serverText(docName);
        const bMatch = seedText.match(/<Callout type="warning">[\s\S]*?<\/Callout>/);
        expect(bMatch).toBeTruthy();
        const bSlice = (bMatch as RegExpMatchArray)[0];
        expect(bSlice).toContain('BBB');

        const typed = ' first';
        let interiorA = 'AAA';
        for (let i = 0; i < typed.length; i++) {
          interiorA += typed[i];
          commitFragment(
            a,
            editInterior(currentTree(a), isCallout, (t) => t.startsWith('AAA'), interiorA, true),
          );
          await awaitDocQuiescence(a.doc);
          const prefix = interiorA;
          await expectPersisted(
            docName,
            (s) => normalizeWs(firstCalloutInteriorText(s)) === normalizeWs(prefix),
            `sibling: Callout A keystroke #${i + 1} → interior ${JSON.stringify(prefix)}`,
          );
          const s = serverText(docName);
          expect(s).toContain(bSlice);
          expect(s.match(/<Callout\b/g)).toHaveLength(2);
          expect(s).not.toMatch(INDENTED_CALLOUT);
        }

        await awaitDocQuiescence(a.doc);
        await awaitDocQuiescence(b.doc);
        await assertAllConverged([a, b]);
        const bText = b.doc.getText('source').toString();
        expect(normalizeWs(firstCalloutInteriorText(bText))).toBe('AAA first');
        expect(bText).toContain(bSlice);
      } finally {
        await Promise.all([a.cleanup(), b.cleanup()]);
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );
});
