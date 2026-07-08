/**
 * Source-mode write-back guard (live Observer-A altitude).
 *
 * A source-mode keystroke on indented MDX-JSX (`<Steps>`), with the
 * hidden-but-mounted WYSIWYG TipTap binding as the single-client trigger, was
 * hypothesized to make Server Observer A write Y.Text back re-indented (cursor
 * jump + byte change + broken undo, all faces of the same write-back). The
 * write-back fires only when `serialize(fragment)` exceeds the bridge tolerance
 * for the shape.
 *
 * Empirical verdict (this guard): the re-indent facet is CLOSED on the current
 * base — `foldJsxContainerBoundaryBlanks` brought the faithful `<Steps>`
 * shapes within `normalizeBridge` tolerance, so Observer A no longer re-indents.
 * These guards drive the LIVE Observer-A path (the md->md fixed-point altitude is
 * blind to it) and read RAW `Y.Text('source')` bytes (every shared comparator
 * trimEnds), so a regression that re-opens the write-back reddens here.
 *
 * The cursor-jump facet is downstream of the same write-back (the y-codemirror
 * remap is Y.Text-delta-driven; no Y.Text change => no caret move), so guarding
 * the bytes guards the caret.
 *
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { updateYFragment } from '@tiptap/y-tiptap';
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
  pollDiskContentStable,
  schema,
  type TestClient,
  type TestServer,
} from './test-harness';

// A faithful, blank-line-delimited <Steps> that parses to a real MDX component
// (OK lifts `mdxJsxFlowElement` -> the `jsxComponent` mdast node). The compact
// no-blank-line form can fall back to a non-MDX parse.
const STEPS = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'Content one.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'Content two.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** A genuine WYSIWYG-side fragment commit (null origin => server Observer A sees
 *  a real WYSIWYG mutation, xmlDirty=true) — the same channel the hidden-but-
 *  mounted TipTap binding republishes through. Non-vacuous: it really changes
 *  the fragment, so Observer A runs and its serialize-vs-ytext diff is exercised. */
function applyWysiwygEdit(client: TestClient, markdownAfterEdit: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(markdownAfterEdit));
  client.doc.transact(() => {
    updateYFragment(client.doc, client.fragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

const INDENTED_STEP = /\n[ \t]+<\/?Step\b/; // a <Step>/</Step> tag gaining leading indentation
const INDENTED_STEPS = /\n[ \t]+<\/?Steps\b/;

describe('bug #3 — source-mode write-back guard (re-indent facet closed by #1991)', () => {
  test('the faithful <Steps> parses to a jsxComponent and is a serialize fixed point', () => {
    const tree = mdManager.parse(STEPS) as { content?: Array<{ type?: string }> };
    const topTypes = (tree.content ?? []).map((n) => n.type);
    // The md->md proxy for the write-back gating condition: serialize(parse(x)) === x
    // (within tolerance) means Observer A has nothing beyond-tolerance to write back.
    expect(topTypes).toContain('jsxComponent');
    // <Steps> is a serialize fixed point: pin the exact expected output as a literal
    // (a public-contract assertion), not a serialize(parse(x)) === x round-trip oracle.
    expect(mdManager.serialize(mdManager.parse(STEPS))).toBe(
      '<Steps>\n\n<Step>\n\nContent one.\n\n</Step>\n\n<Step>\n\nContent two.\n\n</Step>\n\n</Steps>\n',
    );
  });

  test('V1 baseline: an isolated source keystroke stays byte-verbatim (no Observer-A write-back)', async () => {
    const docName = `bug3-v1-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS); // seed landed verbatim
      const at = ytext.toString().indexOf('Content one.') + 'Content one'.length;
      client.doc.transact(() => ytext.insert(at, 'X'));
      const expected = ytext.toString();
      await awaitDocQuiescence(client.doc);
      // RAW server bytes: only the X, no re-indent, nothing shuffled.
      expect(getServerState(server, docName)?.ytext.toString()).toBe(expected);
    } finally {
      await client.cleanup();
    }
  });

  test('a concurrent WYSIWYG fragment commit does NOT re-indent the <Steps> in Y.Text', async () => {
    const docName = `bug3-writeback-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, STEPS, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      expect(ytext.toString()).toBe(STEPS);

      // Genuine WYSIWYG-side change (fires Observer A): edit "Content two." text.
      applyWysiwygEdit(client, STEPS.replace('Content two.', 'Content two, edited.'));
      await awaitDocQuiescence(client.doc);

      const after = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(after).toContain('Content two, edited.'); // the edit landed (non-vacuous)
      // bug #3 re-indent facet: the <Steps>/<Step> tags must NOT gain indentation.
      expect(after).not.toMatch(INDENTED_STEP);
      expect(after).not.toMatch(INDENTED_STEPS);
    } finally {
      await client.cleanup();
    }
  });
});

const FENCE = '`'.repeat(3);

// A pristine seed lands, then a genuine WYSIWYG-side commit fires Observer A;
// returns the RAW persisted Y.Text bytes for the tolerance-aware oracle.
async function seedAndEdit(docName: string, seed: string, edited: string): Promise<string> {
  await agentWriteMd(server.port, seed, { docName, position: 'replace' });
  await wait(300);
  const client = await createTestClient(server.port, docName);
  try {
    const ytext = client.doc.getText('source');
    await awaitDocQuiescence(client.doc);
    expect(ytext.toString()).toBe(seed);
    applyWysiwygEdit(client, edited);
    await awaitDocQuiescence(client.doc);
    return getServerState(server, docName)?.ytext.toString() ?? '';
  } finally {
    await client.cleanup();
  }
}

describe('QA canary — Steps live-edit fidelity (Observer-A altitude)', () => {
  /**
   * Fence interiors are phrasing-gated OUT of boundary-whitespace encoding: a
   * 4-space interior line must serialize verbatim (no `&#x20;`/`&#x9;` char-ref
   * injection, no code-flip) even when the fence lives inside a <Step>.
   *
   */
  test('fenced code block with 4-space interior inside a Step survives a WYSIWYG edit', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Intro one.',
      '',
      `${FENCE}js`,
      'const x = 1;',
      '    deepIndented();',
      FENCE,
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Content two.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('Content two.', 'Content two, edited.');
    const after = await seedAndEdit(`canary-fence-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('Content two, edited.'); // non-vacuous: edit landed
    expect(after).toContain('\n    deepIndented();'); // 4-space interior preserved verbatim
    expect(after).not.toContain('&#x20;deepIndented'); // no char-ref injection in fence
    expect(after).not.toContain('&#x9;'); // no tab char-ref injection
    expect(after).not.toMatch(INDENTED_STEP); // tags stay flush-left
    expect(after).not.toMatch(INDENTED_STEPS);
    expect((after.match(/```/g) ?? []).length).toBe(2); // exactly one fence pair (no dup)
  });

  /**
   * `encodeAttentionBoundaries` wraps ~~/== so a boundary space can't drop the
   * mark — strike and highlight inside a <Step> must survive the round-trip.
   *
   */
  test('strike and highlight marks inside a Step are not silently dropped', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Plain intro.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Has ~~struck~~ and ==marked== words.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('Plain intro.', 'Plain intro, edited.');
    const after = await seedAndEdit(`canary-marks-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('Plain intro, edited.'); // non-vacuous
    expect(after).toContain('~~struck~~'); // strike mark survived round-trip
    expect(after).toContain('==marked=='); // highlight mark survived round-trip
    expect(after).not.toMatch(INDENTED_STEP);
  });

  /**
   * List-marker indent is canonically normalized, so the oracle is tolerance-
   * aware: assert no item LOSS or duplication and flush-left tags — never raw
   * byte-identity of the list indentation.
   *
   */
  test('ordered list inside a Step: no item loss or duplication, tags stay flush-left', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Do these:',
      '',
      '1. first',
      '2. second',
      '3. third',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'After.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace('After.', 'After, edited.');
    const after = await seedAndEdit(`canary-list-${crypto.randomUUID()}`, seed, edited);

    expect(after).toContain('After, edited.'); // non-vacuous
    expect(after).toContain('first');
    expect(after).toContain('second');
    expect(after).toContain('third');
    // no duplication: each item text appears exactly once
    expect((after.match(/\bfirst\b/g) ?? []).length).toBe(1);
    expect((after.match(/\bsecond\b/g) ?? []).length).toBe(1);
    expect((after.match(/\bthird\b/g) ?? []).length).toBe(1);
    expect(after).not.toMatch(INDENTED_STEP);
    expect(after).not.toMatch(INDENTED_STEPS);
  });

  /**
   * The canonical github-sync shape: 4 flush-left <Step> tags with 4-space-
   * indented bodies. Edit one body via WYSIWYG; assert no tag re-indent, no
   * growth, no duplicate <Steps>.
   *
   */
  test('github-sync 4-Step shape (flush-left tags, indented bodies): edit one body, no corruption', async () => {
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      '### Connect',
      '',
      '    Link your repo to start syncing.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Configure',
      '',
      '    Choose a branch and a folder.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Sync',
      '',
      '    Changes flow both ways.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      '### Done',
      '',
      '    Your docs are live.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    const edited = seed.replace(
      'Choose a branch and a folder.',
      'Choose a branch and a folder to sync.',
    );
    const before = mdManager.serialize(mdManager.parse(seed));
    const after = await seedAndEdit(`canary-gh-${crypto.randomUUID()}`, before, edited);

    expect(after).toContain('Choose a branch and a folder to sync.'); // non-vacuous
    expect((after.match(/<Steps>/g) ?? []).length).toBe(1); // no duplicate container
    expect((after.match(/<Step>/g) ?? []).length).toBe(4); // all four steps, once each
    expect(after).not.toMatch(INDENTED_STEP); // tags not re-indented
    // no runaway growth (duplication blows length up multiplicatively)
    expect(after.length).toBeLessThan(before.length + 64);
  });
});

describe('QA canary — cold-reopen / concurrent-peer / idempotence (Observer-A altitude)', () => {
  /**
   * TRUE cold reopen: edit fires Observer A, then read the PERSISTED DISK bytes
   * (what a fresh reader/reopen parses) and confirm no corruption + disk==memory.
   *
   */
  test('cold reopen: 4-Step github-sync shape edited via WYSIWYG, disk bytes uncorrupted + match memory', async () => {
    const docName = `canary-cold-${crypto.randomUUID()}`;
    const seed = mdManager.serialize(
      mdManager.parse(
        [
          '<Steps>',
          '',
          '<Step>',
          '',
          '### Connect',
          '',
          'Link your repo.',
          '',
          '</Step>',
          '',
          '<Step>',
          '',
          '### Configure',
          '',
          'Choose a branch.',
          '',
          '</Step>',
          '',
          '<Step>',
          '',
          '### Sync',
          '',
          'Changes flow both ways.',
          '',
          '</Step>',
          '',
          '</Steps>',
          '',
        ].join('\n'),
      ),
    );
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      applyWysiwygEdit(client, seed.replace('Choose a branch.', 'Choose a branch and folder.'));
      await awaitDocQuiescence(client.doc);

      const diskPath = join(server.contentDir, `${docName}.md`);
      const disk = await pollDiskContentStable(diskPath, (c) =>
        c.includes('Choose a branch and folder.'),
      );
      const memory = getServerState(server, docName)?.ytext.toString() ?? '';

      expect(disk).toContain('Choose a branch and folder.'); // edit persisted
      expect(disk).not.toMatch(INDENTED_STEP); // tags not re-indented on disk
      expect((disk.match(/<Steps>/g) ?? []).length).toBe(1);
      expect((disk.match(/<Step>/g) ?? []).length).toBe(3);
      expect(disk.length).toBeLessThan(seed.length + 64); // no runaway growth
      expect(disk.trimEnd()).toBe(memory.trimEnd()); // disk == memory: no persist drift
    } finally {
      await client.cleanup();
    }
  });

  /**
   * Concurrent-peer convergence on a <Steps> doc: two clients type into
   * different Steps; both edits survive, structure intact, no duplication.
   *
   */
  test('concurrent peers typing into different Steps converge with both edits, no dup', async () => {
    const docName = `canary-concurrent-${crypto.randomUUID()}`;
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Content one.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Content two.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const clients = await createTestClients(server.port, { count: 2, docName });
    try {
      await assertAllConverged(clients, { timeout: 5000 });
      const a = clients[0].ytext;
      const b = clients[1].ytext;
      clients[0].doc.transact(() =>
        a.insert(a.toString().indexOf('Content one.') + 'Content one'.length, ' (A)'),
      );
      clients[1].doc.transact(() =>
        b.insert(b.toString().indexOf('Content two.') + 'Content two'.length, ' (B)'),
      );
      await assertAllConverged(clients, { timeout: 5000 });

      const after = clients[0].ytext.toString();
      expect(after).toContain('(A)');
      expect(after).toContain('(B)');
      expect((after.match(/<Step>/g) ?? []).length).toBe(2); // both steps, once each
      expect((after.match(/Content one/g) ?? []).length).toBe(1);
      expect((after.match(/Content two/g) ?? []).length).toBe(1);
      expect(after).not.toMatch(INDENTED_STEP);
    } finally {
      await Promise.all(clients.map((c) => c.cleanup()));
    }
  });

  /**
   * Idempotence: a second identical-shape WYSIWYG drain produces no growth or
   * drift beyond the first.
   *
   */
  test('repeated identical WYSIWYG drain on a <Steps> doc is idempotent (no growth/drift)', async () => {
    const docName = `canary-idem-${crypto.randomUUID()}`;
    const seed = [
      '<Steps>',
      '',
      '<Step>',
      '',
      'Alpha.',
      '',
      '</Step>',
      '',
      '<Step>',
      '',
      'Beta.',
      '',
      '</Step>',
      '',
      '</Steps>',
      '',
    ].join('\n');
    await agentWriteMd(server.port, seed, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const edited = seed.replace('Alpha.', 'Alpha, edited.');
      applyWysiwygEdit(client, edited);
      await awaitDocQuiescence(client.doc);
      const s1 = getServerState(server, docName)?.ytext.toString() ?? '';
      applyWysiwygEdit(client, edited); // identical drain again
      await awaitDocQuiescence(client.doc);
      const s2 = getServerState(server, docName)?.ytext.toString() ?? '';

      expect(s1).toContain('Alpha, edited.');
      expect(s2).toBe(s1); // idempotent: no drift, no growth on repeated identical drain
      expect((s2.match(/<Step>/g) ?? []).length).toBe(2);
    } finally {
      await client.cleanup();
    }
  });
});

// Real repo docs as fixtures (not reconstructions) — the highest-fidelity
// canary: the exact files a user edits. Paths resolve from this test file up to
// the OK root, then into docs/. Re-verify shape (docs evolve) as a fixture-drift
// guard inside the load test.
const OK_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const GITHUB_SYNC = join(OK_ROOT, 'docs', 'content', 'features', 'github-sync.mdx');
const QUICKSTART = join(OK_ROOT, 'docs', 'content', 'get-started', 'quickstart.mdx');

describe('QA canary — real repo docs with <Steps>', () => {
  /**
   * The real github-sync.mdx loads byte-clean through the bridge, with a
   * fixture-drift precondition (title / 4 flush-left <Step> / 4-space bodies)
   * so a doc rewrite that changes the canonical shape reddens here.
   *
   */
  test('github-sync.mdx loads byte-clean through the bridge (frontmatter + Callout + Steps intact)', async () => {
    const md = readFileSync(GITHUB_SYNC, 'utf-8');
    // Fixture-drift guard: the real doc must still carry the canonical shape.
    expect(md).toContain('title: GitHub sync');
    expect((md.match(/^<Step>$/gm) ?? []).length).toBe(4); // flush-left <Step> tags
    expect(md).toMatch(/^<Steps>$/m);
    expect(md).toMatch(/\n {4}### /); // 4-space-indented Step body headings
    expect(md).not.toMatch(INDENTED_STEP); // tags flush-left at rest

    const docName = `real-gh-load-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const ytext = client.doc.getText('source').toString();
      expect(ytext).toContain('title: GitHub sync'); // frontmatter survived
      expect(ytext).toContain('<Callout type="warn">'); // sibling JSX survived
      expect((ytext.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(ytext).not.toMatch(INDENTED_STEP); // tags not re-indented on load
      expect(ytext).toMatch(/\n {4}### Open the clone dialog/); // body indent preserved
      // bridge fixed point: re-serializing the parsed source drifts nothing beyond tolerance
      expect(mdManager.serialize(mdManager.parse(ytext))).toBe(
        mdManager.serialize(mdManager.parse(md)),
      );
    } finally {
      await client.cleanup();
    }
  });

  /**
   * Live source keystroke inside a real Step fires no Observer-A re-indent, and
   * the persisted disk bytes a fresh reopen parses stay clean (disk == memory).
   *
   */
  test('live source edit inside a real Step fires no Observer-A re-indent; disk cold-reopen clean', async () => {
    const md = readFileSync(GITHUB_SYNC, 'utf-8');
    const docName = `real-gh-edit-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      const ytext = client.doc.getText('source');
      await awaitDocQuiescence(client.doc);
      const anchor = 'Paste a repository URL';
      const at = ytext.toString().indexOf(anchor) + anchor.length;
      expect(at).toBeGreaterThan(anchor.length); // anchor exists in the real doc
      client.doc.transact(() => ytext.insert(at, ' (edited)'));
      await awaitDocQuiescence(client.doc);

      const memory = getServerState(server, docName)?.ytext.toString() ?? '';
      expect(memory).toContain('Paste a repository URL (edited)'); // edit landed
      expect(memory).not.toMatch(INDENTED_STEP); // NO re-indent write-back
      expect((memory.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(memory).toContain('title: GitHub sync'); // frontmatter untouched
      expect(memory.length).toBeLessThan(md.length + 32); // no growth

      const disk = await pollDiskContentStable(join(server.contentDir, `${docName}.md`), (c) =>
        c.includes('Paste a repository URL (edited)'),
      );
      expect(disk).not.toMatch(INDENTED_STEP);
      expect((disk.match(/^<Step>$/gm) ?? []).length).toBe(4);
      expect(disk.trimEnd()).toBe(memory.trimEnd()); // disk == memory: no persist drift
    } finally {
      await client.cleanup();
    }
  });

  /**
   * A real mixed Steps + Tabs doc (quickstart.mdx) loads byte-clean and is a
   * bridge fixed point.
   *
   */
  test('quickstart.mdx (Steps + Tabs) loads byte-clean through the bridge', async () => {
    const md = readFileSync(QUICKSTART, 'utf-8');
    const docName = `real-qs-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, md, { docName, position: 'replace' });
    await wait(300);
    const client = await createTestClient(server.port, docName);
    try {
      await awaitDocQuiescence(client.doc);
      const ytext = client.doc.getText('source').toString();
      expect(ytext).toMatch(/^<Steps>$/m);
      expect(ytext).not.toMatch(INDENTED_STEP);
      expect(mdManager.serialize(mdManager.parse(ytext))).toBe(
        mdManager.serialize(mdManager.parse(md)),
      );
    } finally {
      await client.cleanup();
    }
  });
});
