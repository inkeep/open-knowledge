/**
 * Observer A — freshness-respell suppression on diverged-baseline drains (the
 * `<Steps>` source-authoring duplication class).
 *
 * The race: during rapid source-mode typing, the hidden WYSIWYG editor's
 * y-sync writeback fires Observer A with a fragment whose jsxComponent
 * children reflect newer text than their stamped `sourceRaw`, while a
 * concurrent keystroke has already advanced Y.Text past Observer A's settled
 * raw witness. If serialize re-derives the diverged component (the freshness
 * backstop), it emits the INDENTED nested-JSX respelling of the same block
 * Y.Text holds FLUSH-LEFT — de-anchoring the write from the raw history that
 * every downstream convergence mechanism (the fragment-unchanged gate, the
 * normalize gate, the splice text-match, Path B's diff3, CRDT merge against
 * concurrent keystrokes) line-matches on. Under full-suite contention the
 * de-anchored write lands the block TWICE in the authoritative bytes
 * (`Step one body.` duplicated — the browser canary failure).
 *
 * The fix is drain-scoped: Observer A reads raw-witness coherence before
 * serializing and passes `skipFreshnessDerive: true` on diverged drains, so
 * the emission stays byte-aligned with the pristine `sourceRaw` (freshness is
 * a standing state check — the divergence re-derives on the next settled
 * drain, so G1 still holds). The producer guard is also skipped on suppressed
 * drains: the emission is knowingly historical, and a content-loss verdict
 * against it would be a false alarm.
 *
 * The diverged drain is staged deterministically: one transaction carries
 * BOTH the echo-shaped fragment mutation AND the Y.Text advance, so the
 * settlement drain sees `currentText !== lastSyncedYTextBytes` — the exact
 * interleaving contention produces. Byte-level corruption itself only
 * manifests under real cross-peer concurrency (the browser canaries own that
 * rung); these tests pin the suppression WIRING and the drain's clean
 * convergence.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import {
  type JSONContent,
  MarkdownManager,
  type SerializeCallOptions,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { type SetupServerObserversOpts, setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

// One generation behind: the settled state whose sourceRaw stamps the echo carries.
const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
// The advanced truth: the user's next keystroke landed in Y.Text (flush-left).
const GEN2 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one body.\n\n</Step>\n\n</Steps>\n';

type J = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: J[] };

function mutateFirstText(node: J, from: string, to: string): boolean {
  if (typeof node.text === 'string' && node.text === from) {
    node.text = to;
    return true;
  }
  for (const child of node.content ?? []) {
    if (mutateFirstText(child, from, to)) return true;
  }
  return false;
}

/** Freshness-ON manager (the server posture, packages/server/src/md-manager.ts)
 *  wrapped to record the per-call serialize options Observer A passes. */
function makeRecordingManager(): {
  manager: MarkdownManager;
  serializeOpts: Array<SerializeCallOptions | undefined>;
} {
  const real = new MarkdownManager({
    extensions: sharedExtensions,
    deriveStructuralFreshness: true,
  });
  const serializeOpts: Array<SerializeCallOptions | undefined> = [];
  const manager = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: JSONContent, opts?: SerializeCallOptions) => {
          serializeOpts.push(opts);
          return target.serialize(json, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { manager, serializeOpts };
}

describe('Observer A — freshness suppression on diverged-baseline drains', () => {
  test('settled drain serializes WITH freshness; diverged drain suppresses it; bytes converge to truth', () => {
    const { manager, serializeOpts } = makeRecordingManager();
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager: manager,
      schema,
      docName: 'respell-suppression.md',
    } as SetupServerObserversOpts);
    try {
      // Settlement drain: raw witness coherent → freshness ACTIVE (the
      // feature's designed domain — G1 depends on it).
      const gen1Node = schema.nodeFromJSON(manager.parse(GEN1));
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, gen1Node, { mapping: new Map(), isOMark: new Map() });
      }, null);
      expect(ytext.toString()).toContain('Step one bod');
      // The drain's top-level serialize passed an explicit non-suppressed
      // option (internal helpers — e.g. the splice's per-block serializes —
      // also land in the recording without options, so match by presence).
      expect(serializeOpts.some((o) => o?.skipFreshnessDerive === false)).toBe(true);
      expect(serializeOpts.some((o) => o?.skipFreshnessDerive === true)).toBe(false);

      // The echo shape: children advanced to GEN2's interior, sourceRaw left
      // at GEN1's stamps (parse(GEN1) stamped them; the JSON mutation below
      // touches only the text leaf).
      const echoTree = manager.parse(GEN1) as J;
      if (!mutateFirstText(echoTree, 'Step one bod', 'Step one body.')) {
        throw new Error('staging failed: interior leaf not found');
      }
      const echoNode = schema.nodeFromJSON(echoTree as JSONContent);

      // ONE transaction: fragment echo-writeback + concurrent Y.Text
      // keystroke → the drain sees a diverged raw witness.
      const before = serializeOpts.length;
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, echoNode, { mapping: new Map(), isOMark: new Map() });
        ytext.delete(0, ytext.length);
        ytext.insert(0, GEN2);
      }, null);

      // The diverged drain's serialize was SUPPRESSED.
      const divergedCalls = serializeOpts.slice(before);
      expect(divergedCalls.length).toBeGreaterThan(0);
      expect(divergedCalls.some((o) => o?.skipFreshnessDerive === true)).toBe(true);

      // And the authoritative bytes converge to the typed truth: the block
      // exactly once, flush-left, no character mangling, no respell.
      const finalText = ytext.toString();
      expect((finalText.match(/Step one body\./g) ?? []).length).toBe(1);
      expect((finalText.match(/<Steps>/g) ?? []).length).toBe(1);
      expect((finalText.match(/<Step>/g) ?? []).length).toBe(1);
      expect(finalText).not.toContain('body.y');
      expect(/\n[ \t]+<Step\b/.test(finalText)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('a recent EXTERNAL Y.Text write suppresses freshness even on a witness-coherent drain, until the quiescence window passes', () => {
    // The in-flight variant: client keystrokes can race a re-derived write at
    // the CRDT level even when the raw witness looks coherent at drain time,
    // so witness coherence alone cannot certify the re-derive. Any external
    // Y.Text write inside the quiescence window defers freshness; a drain
    // after the window re-arms it.
    let clock = 1_000_000;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => clock);
    const { manager, serializeOpts } = makeRecordingManager();
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager: manager,
      schema,
      docName: 'quiescence.md',
    } as SetupServerObserversOpts);
    try {
      // Settle GEN1 (fragment-only seed — no external ytext write).
      const gen1Node = schema.nodeFromJSON(manager.parse(GEN1));
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, gen1Node, { mapping: new Map(), isOMark: new Map() });
      }, null);

      // External Y.Text write (a collab keystroke): resets the quiescence
      // clock and settles back through Observer B.
      doc.transact(() => {
        ytext.insert(ytext.length, '\nTrailing.\n');
      }, 'external-peer');

      // A fragment-only drain INSIDE the window: witness is coherent (the
      // external write settled through B), but the doc is not quiescent →
      // freshness suppressed.
      clock += 500;
      const insideWindowStart = serializeOpts.length;
      const echoTree = manager.parse(ytext.toString()) as J;
      if (!mutateFirstText(echoTree, 'Step one bod', 'Step one bod!')) {
        throw new Error('staging failed: interior leaf not found');
      }
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, schema.nodeFromJSON(echoTree as JSONContent), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, null);
      const insideWindow = serializeOpts.slice(insideWindowStart);
      expect(insideWindow.length).toBeGreaterThan(0);
      expect(insideWindow.some((o) => o?.skipFreshnessDerive === true)).toBe(true);

      // Past the window, a fragment-only drain re-arms freshness.
      clock += 10_000;
      const afterWindowStart = serializeOpts.length;
      const laterTree = manager.parse(ytext.toString()) as J;
      if (!mutateFirstText(laterTree, 'Step one bod', 'Step one bod?')) {
        throw new Error('staging failed: interior leaf not found (second)');
      }
      doc.transact(() => {
        updateYFragment(doc, xmlFragment, schema.nodeFromJSON(laterTree as JSONContent), {
          mapping: new Map(),
          isOMark: new Map(),
        });
      }, null);
      const afterWindow = serializeOpts.slice(afterWindowStart);
      expect(afterWindow.length).toBeGreaterThan(0);
      expect(afterWindow.some((o) => o?.skipFreshnessDerive === false)).toBe(true);
    } finally {
      nowSpy.mockRestore();
      cleanup();
    }
  });
});
