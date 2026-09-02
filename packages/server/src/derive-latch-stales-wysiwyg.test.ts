/**
 * Stale-WYSIWYG display latches — the user-visible face of a suspended
 * Observer B, on the REAL `setupServerObservers` drain.
 *
 * Sibling suites assert these mechanisms from the LOSS angle: the defer guard
 * proves an un-propagated WYSIWYG keystroke SURVIVES a re-derive
 * (`derive-timing-guard.test.ts`), and the fixed-point backstop proves a frozen
 * B-direction still persists typed content (`derive-fixed-point-backstop.test.ts`,
 * the `freeze scope` / `typing during a freeze` rows). Both are about bytes not
 * being destroyed.
 *
 * This suite asserts the complementary, previously unpinned property: while
 * either mechanism holds, a source-mode edit is present in Y.Text but ABSENT
 * from the fragment — so the WYSIWYG surface, which renders nothing but that
 * fragment, displays stale content.
 *
 * PROVENANCE — this suite was written while investigating a report of
 * "switched to WYSIWYG and my source-mode edits were not there". It does NOT
 * reproduce that incident: the defer-hold arm requires a node whose `sourceRaw`
 * stamp holds a whole block's raw text (an MDX component), and the reported
 * document had none. That incident was traced to cross-mode undo corruption
 * instead — see `cross-mode-undo-partial-retraction.test.ts` and
 * `cross-mode-undo-redo-table-anchor.test.ts` in `packages/app`. What this
 * suite pins is a real and separate defect of the same shape, on its own
 * merit.
 *
 * The third row is the one that explains why the symptom does not clear itself.
 * `setupServerObservers`' attach-time work records settlement baselines FROM
 * THE CURRENT FRAGMENT and never re-derives it, so re-attaching observers to a
 * doc whose fragment already diverged leaves the divergence in place — a fresh
 * observer closure is not a repair.
 */
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';

/** The line a user types in source mode and then expects to see in the WYSIWYG. */
const SOURCE_SENTINEL = 'Typed in source mode, expected in the WYSIWYG.';

/**
 * Leave the fragment holding `PENDING_LINE` while Y.Text still holds
 * `STALE_LINE`, with the settlement witnesses stale — the un-propagated-keystroke
 * shape whose re-derive the defer guard suspends. Mirrors the staging in
 * `derive-timing-guard.test.ts`; a user reaches it by editing in the WYSIWYG
 * shortly before switching to source mode.
 */
function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  // Reset the freshness-quiescence clock so the echo drain runs suppressed.
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

/** A source-editor keystroke: a non-paired Y.Text write, freshness held hot. */
function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

/** Canonical markdown of a fragment — exactly what the WYSIWYG surface renders. */
function serializeFragment(xmlFragment: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

describe('a suspended Observer B leaves the WYSIWYG displaying stale content', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('while the defer guard holds, a source-mode edit is in Y.Text but not in the fragment', () => {
    const rig = createBridgeRaceRig({ docName: 'stale-wysiwyg-defer.md' });
    try {
      stageUnpropagatedKeystroke(rig);

      sourceWrite(rig, SOURCE_SENTINEL);

      // Y.Text is correct — the source editor shows exactly what was typed.
      expect(rig.ytext.toString()).toContain(SOURCE_SENTINEL);
      // The fragment is not — the WYSIWYG surface renders the pre-edit document.
      // The user-visible symptom, stated as an assertion.
      expect(rig.serializeFragment()).not.toContain(SOURCE_SENTINEL);
      // And the deferred re-derive is why: the keystroke the guard is protecting
      // is still sitting in the fragment.
      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('control: with the defer guard OFF the same source edit reaches the fragment immediately', () => {
    // Proves the row above is guard-driven rather than vacuous. With the guard
    // disabled the re-derive is not suspended, so the source edit lands in the
    // fragment at once — and the un-propagated keystroke the guard exists to
    // protect is stomped, which is the trade the guard makes.
    const rig = createBridgeRaceRig({
      docName: 'stale-wysiwyg-guard-off.md',
      setupOverrides: { deferGuardEnabled: false },
    });
    try {
      stageUnpropagatedKeystroke(rig);

      sourceWrite(rig, SOURCE_SENTINEL);

      expect(rig.ytext.toString()).toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).toContain(SOURCE_SENTINEL);
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('a fresh observer closure DOES repair a diverged fragment — so residency, not attach, is the defect', () => {
    // This row isolates where the production defect actually lives.
    //
    // A brand-new observer closure over a diverged doc (every latch reset:
    // `bDirectionFrozen`, the settlement witnesses, the defer counter) does not
    // reconcile at ATTACH time — `setupServerObservers` records its attach-time
    // baselines from the fragment and there is no bootstrap re-derive. But the
    // very next fragment-dirtying drain routes through Observer A's Path-B merge,
    // which sees `ytextDiverged` and enqueues a split-brain re-derive that
    // rebuilds the fragment from Y.Text. The divergence clears.
    //
    // So re-attaching WOULD fix the symptom. The reason a user's reopen does not
    // is that re-attach never happens: the server keeps the document resident
    // (`server-factory.ts` `shouldUnloadDocument` returns false for any doc with
    // a reconciled base), so `afterUnloadDocument`/`afterLoadDocument` never fire
    // and the latched closure survives. That half is pinned end-to-end in
    // `packages/app/tests/integration/source-to-wysiwyg-stale-on-toggle.test.ts`.
    //
    // Consequence for a future fix: the repair primitive already exists and
    // works. What is missing is a trigger on client re-attach.
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    // Stage a diverged pair directly: the fragment holds the pre-edit document
    // while Y.Text holds the source-mode edit.
    const staleMd = '# Doc\n\nThe body before the source-mode edit.\n';
    const freshMd = `# Doc\n\nThe body before the source-mode edit.\n\n${SOURCE_SENTINEL}\n`;
    doc.transact(() => {
      const pmNode = schema.nodeFromJSON(mdManager.parse(staleMd));
      updateYFragment(doc, xmlFragment, pmNode, { mapping: new Map(), isOMark: new Map() });
      ytext.insert(0, freshMd);
    }, 'stale-stage');

    expect(ytext.toString()).toContain(SOURCE_SENTINEL);
    expect(serializeFragment(xmlFragment)).not.toContain(SOURCE_SENTINEL);

    // "Reopen": a fresh observer closure over the same doc.
    const cleanup = setupServerObservers({ doc, xmlFragment, ytext, mdManager, schema });
    try {
      // Attach alone does not reconcile — there is no bootstrap re-derive.
      expect(serializeFragment(xmlFragment)).not.toContain(SOURCE_SENTINEL);

      // The first fragment-dirtying drain does. Observer A's Path-B merge sees
      // `ytextDiverged`, enqueues a split-brain re-derive, and Observer B
      // rebuilds the fragment from the authoritative Y.Text.
      doc.transact(() => {
        const el = new Y.XmlElement('paragraph');
        xmlFragment.push([el]);
        xmlFragment.delete(xmlFragment.length - 1, 1);
      }, 'settle-probe');

      expect(ytext.toString()).toContain(SOURCE_SENTINEL);
      expect(serializeFragment(xmlFragment)).toContain(SOURCE_SENTINEL);
    } finally {
      cleanup();
    }
  });
});
