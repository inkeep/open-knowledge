/**
 * Path B merge-input doc-boundary alignment — user-outcome contract.
 *
 * mergeThreeWay is a line-based diff3 over raw bytes: its three inputs
 * (baseline, userText, agentText) must share ONE doc-boundary byte-space.
 * The Path B compose in `runObserverASyncImpl` builds userText from
 * `prependFrontmatter(fm, serialize(fragment))` — a live Y.XmlFragment
 * structurally cannot carry the `sourceDocBoundary` doc-node attr, so the
 * user's blank line between the FM close fence and the body is missing from
 * userText while baseline/agentText (raw Y.Text bytes) carry it. diff3's
 * line alignment then reads the user's edited first body line into the
 * blank-line slot and presents the original paragraph as user-deleted; the
 * conflict resolution resurrects the agent's copy next to the user's copy.
 *
 * These tests pin the user-visible outcome on the real observer pipeline
 * (real setupServerObservers + composeAndWriteRawBody on a raw Y.Doc):
 * after an in-tolerance W2 source edit (unabsorbed — Observer B early-exits
 * within normalizeBridge tolerance) plus a WYSIWYG edit, the merged Y.Text
 * must carry BOTH edits verbatim and fabricate nothing:
 *   (a) no content duplication,
 *   (b) the user's doc-boundary blank line survives (storage never
 *       sanitizes — the blank line is user bytes in the body region),
 *   (c) a fence-line keystroke survives byte-exactly (`--- ` stays `--- `,
 *       not `---  `). These byte-exact pins are the strengthening
 *       counterpart to the deliberately-weakened class pins
 *       (`/^---[ \t]+$/`) in server-observers.fm-fence-hazard.test.ts —
 *       additive; the class pins stay as-is.
 *
 * The expected bytes are defined by the aligned-input oracle: feeding
 * mergeThreeWay the same edits with all three inputs in one boundary
 * byte-space merges cleanly with both edits landing verbatim.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  BridgeMergeContentLossError,
  MarkdownManager,
  prependFrontmatter,
  reattachLeadingDocBoundary,
  sharedExtensions,
  splitLeadingDocBoundary,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { __resetBridgeWatchdogForTests } from './bridge-watchdog.ts';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const USER_TYPING_ORIGIN = {
  source: 'connection' as const,
  context: { origin: 'user-typing' },
};

const FM = '---\ntitle: Boundary alignment\n---\n';
const RAW = `${FM}\nFirst paragraph body.\n\nSecond paragraph stays.\n`;

function canonicalOf(raw: string): string {
  const { frontmatter, body } = stripFrontmatter(raw);
  return prependFrontmatter(frontmatter, mdManager.serialize(mdManager.parseWithFallback(body)));
}

/** Seed a doc production-order: paired-write intake first, attach second. */
function seedThenAttach(raw: string, docName: string) {
  __resetBridgeWatchdogForTests();
  resetMetrics();
  const doc = new Y.Doc();
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  doc.transact(() => {
    composeAndWriteRawBody(doc, raw, 'file-watcher');
  }, FILE_WATCHER_ORIGIN);
  const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema, docName });
  return { doc, xmlFragment, ytext, cleanup };
}

function findTextNodeContaining(
  node: Y.XmlFragment | Y.XmlElement,
  needle: string,
): Y.XmlText | null {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText && child.toString().includes(needle)) return child;
    if (child instanceof Y.XmlElement) {
      const found = findTextNodeContaining(child, needle);
      if (found) return found;
    }
  }
  return null;
}

/** Insert one character at the start of the text node containing `needle`. */
function typeIntoParagraph(doc: Y.Doc, xmlFragment: Y.XmlFragment, needle: string): void {
  doc.transact(() => {
    const textNode = findTextNodeContaining(xmlFragment, needle);
    if (!textNode) throw new Error(`no fragment text node containing ${JSON.stringify(needle)}`);
    textNode.insert(0, 'Z');
  }, USER_TYPING_ORIGIN);
}

/** W2 source-mode keystroke: insert `ws` at `index` in Y.Text. */
function typeIntoSource(doc: Y.Doc, ytext: Y.Text, index: number, ws: string): void {
  doc.transact(() => {
    ytext.insert(index, ws);
  }, USER_TYPING_ORIGIN);
}

describe('Path B doc-boundary alignment: diverged-branch merge fabrication', () => {
  test('precondition: the fixture is round-trip byte-stable', () => {
    expect(canonicalOf(RAW)).toBe(RAW);
  });

  /**
   * Diverged Path B fire: an in-tolerance W2 edit (trailing space at the end
   * of the first body line — Observer B early-exits, witnesses go stale, raw
   * Y.Text diverges from the raw witness) followed by a WYSIWYG edit on the
   * first body paragraph. The merge must land both edits without fabricating
   * a second copy of the paragraph.
   */
  test('first body paragraph is not duplicated; both edits land verbatim', () => {
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(RAW, 'pathb-boundary-dup');
    expect(ytext.toString()).toBe(RAW);

    typeIntoSource(
      doc,
      ytext,
      RAW.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    const finalText = ytext.toString();
    const para1Count = finalText.split('First paragraph body').length - 1;
    expect(para1Count).toBe(1);
    // Both edits on the one surviving line: WYSIWYG 'Z' prefix + the W2
    // trailing space (in-tolerance residual — storage never sanitizes).
    expect(finalText).toContain('ZFirst paragraph body. \n');
    expect(finalText).toContain('Second paragraph stays.');

    cleanup();
  });

  test('the user doc-boundary blank line survives the merge byte-exactly', () => {
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(RAW, 'pathb-boundary-blank');

    typeIntoSource(
      doc,
      ytext,
      RAW.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    const finalText = ytext.toString();
    // The blank line between the FM close fence and the body is user bytes
    // in the body region of Y.Text — the merge must not delete it.
    expect(finalText).toContain('---\n\n');
    // Full byte-exact settlement, per the aligned-input oracle.
    expect(finalText).toBe(`${FM}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`);

    cleanup();
  });
});

interface CloseFenceVariant {
  name: string;
  slug: string;
  ws: string;
  /** Needle of the paragraph receiving the WYSIWYG edit. */
  editNeedle: string;
  expectedFinal: string;
}

const CLOSE_FENCE_VARIANTS: CloseFenceVariant[] = [
  {
    name: 'trailing space, adjacent WYSIWYG edit',
    slug: 'space-adjacent',
    ws: ' ',
    editNeedle: 'First paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n--- \n\nZFirst paragraph body.\n\nSecond paragraph stays.\n`,
  },
  {
    name: 'trailing tab, adjacent WYSIWYG edit',
    slug: 'tab-adjacent',
    ws: '\t',
    editNeedle: 'First paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n---\t\n\nZFirst paragraph body.\n\nSecond paragraph stays.\n`,
  },
  {
    name: 'trailing space, distal WYSIWYG edit',
    slug: 'space-distal',
    ws: ' ',
    editNeedle: 'Second paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n--- \n\nFirst paragraph body.\n\nZSecond paragraph stays.\n`,
  },
  {
    name: 'trailing tab, distal WYSIWYG edit',
    slug: 'tab-distal',
    ws: '\t',
    editNeedle: 'Second paragraph',
    expectedFinal: `---\ntitle: Boundary alignment\n---\t\n\nFirst paragraph body.\n\nZSecond paragraph stays.\n`,
  },
];

describe('Path B doc-boundary alignment: close-fence keystroke byte-exactness', () => {
  for (const variant of CLOSE_FENCE_VARIANTS) {
    test(`${variant.name}: keystroke survives verbatim, no fabricated whitespace`, () => {
      const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(
        RAW,
        `pathb-close-fence-${variant.slug}`,
      );

      // W2 keystroke: trailing whitespace at the end of the FM close fence.
      typeIntoSource(doc, ytext, RAW.indexOf('\n---\n') + '\n---'.length, variant.ws);
      expect(ytext.toString()).toContain(`---${variant.ws}\n`);

      typeIntoParagraph(doc, xmlFragment, variant.editNeedle);

      const finalText = ytext.toString();
      // Byte-exact: exactly the keystroke the user typed — `---<ws>`, not
      // `---<ws><ws>`. Implies (and strengthens) the fm-fence-hazard class
      // pin `/^---[ \t]+$/`.
      const closeFence = finalText
        .split('\n')
        .slice(1)
        .find((line) => /^---[ \t]*$/.test(line));
      expect(closeFence).toBe(`---${variant.ws}`);
      // Full byte-exact settlement: keystroke verbatim, boundary blank line
      // kept, WYSIWYG edit applied, nothing fabricated.
      expect(finalText).toBe(variant.expectedFinal);

      cleanup();
    });
  }
});

describe('in-sync residual merge (sibling router branch) — byte-preservation guard', () => {
  /**
   * GUARD (currently green, not a bug repro): the in-sync residual-merge
   * branch feeds the SAME mergeThreeWay call site with a canonical-space
   * base against raw-space agent bytes. Reachable in-sync input shapes merge
   * cleanly today because the agent never carries an edit beyond the
   * NG-class residual itself; this pins that a fix aligning the Path B
   * merge inputs does not regress the residual branch's byte preservation
   * (un-padded table bytes + the boundary blank line survive, the WYSIWYG
   * edit lands inside the un-padded form).
   */
  test('NG-residual doc: WYSIWYG cell edit preserves un-padded table bytes and boundary blank line', () => {
    const rawResidual = `${FM}\n|a|b|\n|-|-|\n|1|2|\n\nSecond paragraph stays.\n`;
    const { doc, xmlFragment, ytext, cleanup } = seedThenAttach(rawResidual, 'pathb-residual-ng');

    // No Y.Text edit — Y.Text stays at the settled raw witness, so the
    // router classifies in-sync; the beyond-tolerance un-padded table makes
    // the drain residual-merge-eligible rather than Path A.
    typeIntoParagraph(doc, xmlFragment, 'a');

    expect(ytext.toString()).toBe(`${FM}\n|Za|b|\n|-|-|\n|1|2|\n\nSecond paragraph stays.\n`);

    cleanup();
  });
});

/**
 * Recovery arm (production policy): when the Path B merge trips the
 * content-preservation post-condition, production logs + checkpoints + applies
 * the merge as-computed (it does NOT rethrow). The success path re-attaches the
 * Y.Text boundary to the merge result; the recovery arm must re-attach it to
 * `mergeErr.info.result` the same way, or a production loss reintroduces the
 * boundary corruption the projection prevents — on the highest-stakes path, where the
 * editor falls back to the as-computed bytes.
 *
 * That arm is unreachable organically: Observer A's agent side (current Y.Text)
 * only drifts from the merge baseline by in-tolerance whitespace, so the hybrid
 * merge never drops non-whitespace content from a constructible fixture (the
 * 2-3% residual is a multi-edit fuzz artifact). The throw is therefore
 * fault-injected at the merge seam (`opts.mergeThreeWay`, the test-only
 * counterpart of the divergent-fallback harness's `mdManager` proxy), with a
 * crafted `info.result` in MERGE byte-space (boundary normalized to one `\n`),
 * exactly what `mergeThreeWayImpl` returns before the call site re-attaches the
 * boundary. The fixture's doc boundary is an NG-class multi-blank run, so the
 * merge-space single-`\n` form and the re-attached form differ observably — a
 * regression that applied raw `info.result` would collapse the run.
 */
describe('Path B doc-boundary alignment: content-loss recovery arm re-projects the boundary', () => {
  const ENV_KEYS = ['NODE_ENV', 'OK_RETHROW_BRIDGE_LOSS'] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    // Production policy: the recovery arm runs (no rethrow at the throw gate).
    process.env.NODE_ENV = 'production';
    delete process.env.OK_RETHROW_BRIDGE_LOSS;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const FM2 = '---\ntitle: Boundary recovery\n---\n';
  // NG-class doc boundary: a multi-blank run ('\n\n') between the FM close
  // fence and the body. The merge space normalizes the run to one '\n', so the
  // boundary re-attached from the current Y.Text differs observably from the
  // merge-space as-computed bytes.
  const RAW_NG = `${FM2}\n\nFirst paragraph body.\n\nSecond paragraph stays.\n`;

  test('applies the boundary-reattached as-computed bytes, not raw info.result', () => {
    __resetBridgeWatchdogForTests();
    resetMetrics();

    // Stands in for a production merge that lands both edits but trips the
    // post-condition on some lost substring. In MERGE byte-space: one '\n' in
    // the boundary slot, the WYSIWYG 'Z' prefix and the in-tolerance trailing
    // space present.
    const asComputedMergeSpace = `${FM2}\nZFirst paragraph body. \n\nSecond paragraph stays.\n`;
    const throwingMerge = (): never => {
      throw new BridgeMergeContentLossError({
        baseline: RAW_NG,
        userText: asComputedMergeSpace,
        agentText: RAW_NG,
        result: asComputedMergeSpace,
        lostSubstrings: ['a-dropped-line'],
        which: 'substring',
        side: 'user',
      });
    };

    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    doc.transact(() => {
      composeAndWriteRawBody(doc, RAW_NG, 'file-watcher');
    }, FILE_WATCHER_ORIGIN);
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
      docName: 'pathb-boundary-recovery',
      mergeThreeWay: throwingMerge,
    });
    expect(ytext.toString()).toBe(RAW_NG);

    // In-tolerance W2 edit diverges Y.Text from the raw witness, then a WYSIWYG
    // edit routes the next settlement through Observer A Path B → the injected
    // throw → the production recovery arm.
    typeIntoSource(
      doc,
      ytext,
      RAW_NG.indexOf('First paragraph body.') + 'First paragraph body.'.length,
      ' ',
    );
    typeIntoParagraph(doc, xmlFragment, 'First paragraph');

    // The recovery arm fired (guards against the injected throw being silently
    // skipped, e.g. a routing change that no longer reaches Path B).
    expect(getMetrics().bridgeMergeContentLoss).toBe(1);

    const finalText = ytext.toString();
    // The current Y.Text's multi-blank boundary is re-attached verbatim — the
    // recovery applied projectMerged(info.result), not the merge-space bytes.
    expect(finalText).toContain(`${FM2}\n\n`);
    // Exactly the as-computed bytes with the boundary re-projected from the
    // current Y.Text. A regression applying raw `info.result` would land the
    // merge-space single-'\n' boundary here instead.
    const boundary = splitLeadingDocBoundary(RAW_NG).boundary;
    const expected = reattachLeadingDocBoundary(
      splitLeadingDocBoundary(asComputedMergeSpace).text,
      boundary,
    );
    expect(finalText).toBe(expected);
    expect(finalText).toBe(`${FM2}\n\nZFirst paragraph body. \n\nSecond paragraph stays.\n`);

    cleanup();
  });
});
