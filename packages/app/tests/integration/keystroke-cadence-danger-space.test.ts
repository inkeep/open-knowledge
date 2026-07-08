/**
 * Keystroke-cadence fidelity inside registered danger-space components.
 *
 * The Observer-A producer guard and the server-side structural-freshness
 * derivation each run once per Observer-A drain. The existing tests exercise
 * them with single-shot programmatic edits, and the only char-by-char coverage
 * types into an UNREGISTERED <Steps> (wildcard raw-source), which bypasses both.
 * This closes that gap: it drives REAL per-keystroke cadence into a registered
 * danger-space interior — a Callout (jsxComponent → producer guard + structural
 * freshness) and a table cell (table / tableCell → producer guard) — through the
 * transient intermediate states typing passes through.
 *
 * Cadence model: each character is its own null-origin transaction with a
 * quiescence + server-drain settle before the next, so every keystroke is an
 * independent Observer-A drain that fires the guard and the freshness check.
 * Under `bun test` the guard is in its loud (throw) posture, so a false-fire
 * aborts that drain BEFORE the Y.Text write — the per-keystroke assertion that
 * the growing text reached the persisted server Y.Text then fails AT the
 * keystroke that fired, before the next keystroke's full re-serialize can heal
 * it. Freshness runs on the no-flip cases (a stale `sourceRaw` vs the live
 * children), so those drains re-derive fresh bytes per keystroke.
 *
 * Oracles are tolerance-aware — structure + survival, never raw byte-identity:
 * the typed text survives, container tags stay singular and un-re-indented, and
 * a pristine registered sibling is not re-derived while another node is typed
 * into. Multi-client convergence proves the read-only guard does not perturb the
 * observer seam for a remote peer.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
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

// A registered Callout whose interior is a real paragraph (the NodeViewContent
// hole an author types into). Blank-line delimited so it lifts to a jsxComponent.
const CALLOUT_SEED = ['<Callout type="info">', '', 'Note:', '', '</Callout>', ''].join('\n');
// A GFM table: the body cell is a tableCell (danger space), the header a
// tableHeader — the finder targets the body cell only.
const TABLE_SEED = ['| Head |', '| --- |', '| seed |', ''].join('\n');
// Two sibling Callouts: type into the first, prove the second (pristine,
// untouched) is never re-derived while the freshness check runs on both.
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

const INDENTED_CALLOUT = /\n[ \t]+<\/?Callout\b/; // a <Callout>/</Callout> tag gaining leading indent
const KEYSTROKE_TEST_TIMEOUT_MS = 30_000;

type PmNodeJson = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PmNodeJson[];
  marks?: unknown[];
};

/** The doc tree currently in a client's XmlFragment (synced from the server). */
function currentTree(client: TestClient): PmNodeJson {
  return yXmlFragmentToProseMirrorRootNode(client.fragment, schema).toJSON() as PmNodeJson;
}

/** First descendant text node (the leaf a keystroke lands in), or undefined. */
function firstTextNode(node: PmNodeJson): PmNodeJson | undefined {
  if (typeof node.text === 'string') return node;
  for (const child of node.content ?? []) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return undefined;
}

/** Concatenated text of a subtree — the survival stream a faithful round-trip
 *  must not lose. Whitespace-preserving (callers compare exact interior text). */
function subtreeText(node: PmNodeJson): string {
  let acc = node.text ?? '';
  for (const child of node.content ?? []) acc += subtreeText(child);
  return acc;
}

const isCallout = (n: PmNodeJson): boolean =>
  n.type === 'jsxComponent' && n.attrs?.componentName === 'Callout';
const isBodyCell = (n: PmNodeJson): boolean => n.type === 'tableCell';

/**
 * Reproduce one keystroke as its settled wire state: set the first text node
 * inside the first container matching `isContainer` (disambiguated by
 * `whenFirstText` on its current interior) to `nextText`. When `flipDirty`, mark
 * the container `sourceDirty` exactly as the client SourceDirtyObserver would;
 * otherwise leave it pristine so `sourceRaw` goes stale and the server-side
 * structural-freshness derivation must catch the divergence. `sourceRaw` is
 * never touched, so a dirty/diverged container carries a genuinely stale cache.
 */
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

/** Commit a target doc tree into the client fragment with null origin — the same
 *  channel a local WYSIWYG mutation publishes through. `updateYFragment` diffs to
 *  a minimal delta, so growing/shrinking one text node commits a single-char
 *  edit: Observer A sees a real fragment change (xmlDirty=true) per keystroke. */
function commitFragment(client: TestClient, tree: PmNodeJson): void {
  const pmNode = schema.nodeFromJSON(tree);
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

/** Whitespace-normalized form — collapse internal runs, trim ends. Markdown
 *  serialization legitimately strips trailing spaces and collapses blank runs,
 *  so the survival oracle compares content modulo whitespace, never raw bytes. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Text of the first node matching `isTarget`, reconstructed from the persisted
 *  source. Table cells escape markdown-significant characters on serialize (a
 *  literal `|` becomes `\|`), and re-derivation re-flows whitespace, so the
 *  survival oracle reparses and reads the interior text — tolerance-aware
 *  structure+survival, never a raw-byte match. */
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

/** Persisted server-side Y.Text (the bytes a reopen or teammate receives). */
function serverText(docName: string): string {
  return getServerState(server, docName)?.ytext.toString() ?? '';
}

/** Wait for the keystroke's server drain to land (or abort). Polling the SERVER
 *  doc both asserts survival AND enforces per-drain granularity — the next
 *  keystroke is not committed until this one's drain has settled. A timeout means
 *  the drain never wrote the byte: the guard threw (aborted) or the derivation
 *  mangled it. Returns a real boolean (the harness `pollUntil` throws on timeout
 *  and returns void on success — unusable for a distinguishing assertion). */
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
  /**
   * Type into a pristine Callout interior char-by-char WITHOUT the client dirty
   * flip. Each keystroke leaves `sourceRaw` stale against the grown children, so
   * the server structural-freshness derivation must detect divergence and
   * re-derive fresh bytes — while the producer guard (danger space present) must
   * stay silent on every legal intermediate.
   *
   */
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

  /**
   * Same interior, WITH the client dirty flip each keystroke — the provenance
   * fast path a real user edit takes. Exercises the producer guard on the dirty
   * re-derive route (freshness short-circuited by the flip).
   *
   */
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

  /**
   * Type markdown-significant characters (`|`, `*`, backtick) into a table body
   * cell char-by-char. The cell is danger space (guard runs on every drain), and
   * a literal pipe must escape on serialize and reparse to the same literal —
   * the survival oracle compares the reparsed cell text, so an escaping regress
   * that dropped a character would fail it.
   *
   */
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
          // The table structure stays intact: one header separator row.
          expect(serverText(docName)).toMatch(/\|\s*-+\s*\|/);
        }
        expect(firstBodyCellText(serverText(docName))).toBe('seeda|b*c`d');
      } finally {
        await client.cleanup();
      }
    },
    KEYSTROKE_TEST_TIMEOUT_MS,
  );

  /**
   * Adversarial grow → shrink (backspace-correct) → regrow inside a pristine
   * Callout interior. Every step is its own drain (including the shrinking ones a
   * single-shot edit never produces), and freshness must re-derive each without
   * the guard firing on any transient.
   *
   */
  test(
    'Callout interior: grow, backspace-correct, regrow — no guard fire on any transient',
    async () => {
      const docName = `keystroke-correct-${crypto.randomUUID()}`;
      await agentWriteMd(server.port, CALLOUT_SEED, { docName, position: 'replace' });
      await wait(300);
      const client = await createTestClient(server.port, docName);
      try {
        await awaitDocQuiescence(client.doc);

        // Walk a deterministic sequence of interior states: type "abc", delete
        // back to "a", then type "XYZ". Each entry is one settled drain.
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

  /**
   * Sibling isolation: type into the first Callout char-by-char (the realistic
   * user-edit path — the client dirty flip on each keystroke) while the second
   * Callout sits pristine and untouched. The freshness check still runs on the
   * pristine sibling on every serialize pass: it must return NOT-diverged for it,
   * so its exact seed bytes survive byte-stable — a false-divergence would
   * re-derive (and could re-indent) a node the user never touched. Two clients
   * converge on the result, proving the read-only guard does not perturb the
   * observer seam for a remote peer.
   *
   */
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
          // The untouched sibling's exact seed slice survives — no re-derive,
          // no re-indent, no false-divergence.
          expect(s).toContain(bSlice);
          expect(s.match(/<Callout\b/g)).toHaveLength(2);
          expect(s).not.toMatch(INDENTED_CALLOUT);
        }

        // The remote peer received the same fresh bytes: the read-only guard did
        // not perturb convergence, and the pristine sibling is intact there too.
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
