/**
 * The fragment-derive demand gate, on the real `setupServerObservers` drain.
 *
 * Observer B rebuilds `Y.XmlFragment('default')` from `Y.Text('source')` on
 * every source-mode keystroke — a full markdown re-parse, synchronously, whether
 * or not anything will read the result. The gate skips that work while no
 * consumer needs the fragment and pays a catch-up derive when one appears.
 *
 * Three properties decide whether the gate is safe, and each has a row here:
 *
 *   1. INERT BY DEFAULT. With no `fragmentDemand` the observer behaves exactly
 *      as before. Every existing caller omits it, so this is what protects the
 *      untouched deployments — and it is the `control:` row that keeps the
 *      suspension assertions below non-vacuous.
 *   2. SUSPENSION IS HONEST. While the derive is skipped the doc is marked
 *      derive-suspended, which is what lets the bridge-invariant watchdog tell
 *      a by-design divergence from a broken bridge instead of alarming on
 *      normal operation.
 *   3. SUSPENSION IS BOUNDED. Every suspension ends in a catch-up derive that
 *      re-converges the fragment and clears the flag. This is the load-bearing
 *      one: suppressing the watchdog is only defensible if the suppression
 *      always ends, so an unbounded suspension would be a worse defect than
 *      the cost the gate saves.
 */
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { isFragmentDeriveSuspended, resumeFragmentDerive } from './fragment-derive-demand.ts';
import { setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

interface Rig {
  doc: Y.Doc;
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  cleanup: () => void;
  /** Markdown the fragment currently serializes to — what a WYSIWYG would show. */
  fragmentMd: () => string;
  /** Full re-parses Observer B has performed since the rig was built. */
  parses: () => number;
  events: Array<'suspended' | 'resumed'>;
}

const BODY = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';

function makeRig(demand?: () => boolean): Rig {
  const mdManager = new MarkdownManager({ extensions: sharedExtensions });
  let parses = 0;
  const realParse = mdManager.parseWithFallback.bind(mdManager);
  // Counting the observer's own parse is the only way to assert the gate did
  // the thing it exists for; a fragment-equality assertion alone would pass on
  // a doc that re-derived to the same bytes.
  (mdManager as unknown as { parseWithFallback: typeof realParse }).parseWithFallback = (
    md: string,
    opts?: Parameters<typeof realParse>[1],
  ) => {
    parses += 1;
    return realParse(md, opts);
  };

  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');

  // Seed both surfaces converged, the way a real cold load does (paired write).
  doc.transact(() => {
    ytext.insert(0, BODY);
    updateYFragment(doc, fragment, schema.nodeFromJSON(mdManager.parse(BODY)), {
      mapping: new Map(),
      isOMark: new Map(),
    } as never);
  });

  const events: Array<'suspended' | 'resumed'> = [];
  const cleanup = setupServerObservers({
    doc,
    xmlFragment: fragment,
    ytext,
    mdManager,
    schema,
    docName: 'demand-rig.md',
    fragmentDemand: demand,
    onDeriveDemandChange: (e) => events.push(e),
  });

  const baseline = parses;
  return {
    doc,
    ytext,
    fragment,
    cleanup,
    fragmentMd: () =>
      mdManager.serialize(yXmlFragmentToProseMirrorRootNode(fragment, schema).toJSON()),
    parses: () => parses - baseline,
    events,
  };
}

let rig: Rig | undefined;
beforeEach(() => {
  rig = undefined;
});
afterEach(() => {
  rig?.cleanup();
});

/** One source-mode keystroke: appends a word to the first paragraph. */
function typeInSource(r: Rig, text: string): void {
  const at = r.ytext.toString().indexOf('First paragraph.') + 'First paragraph.'.length;
  r.doc.transact(() => r.ytext.insert(at, text));
}

describe('fragment-derive demand gate', () => {
  test('control: with no demand predicate the fragment tracks Y.Text (unchanged behaviour)', () => {
    rig = makeRig();
    typeInSource(rig, ' EDIT');

    expect(rig.parses()).toBeGreaterThan(0);
    expect(rig.fragmentMd()).toContain('First paragraph. EDIT');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(false);
    expect(rig.events).toEqual([]);
  });

  test('no demand → the re-parse is skipped and the doc is marked suspended', () => {
    rig = makeRig(() => false);
    typeInSource(rig, ' EDIT');

    expect(rig.parses()).toBe(0);
    // Y.Text — the source of truth — still has the keystroke. Only the derived
    // replica is behind, which is the whole point.
    expect(rig.ytext.toString()).toContain('First paragraph. EDIT');
    expect(rig.fragmentMd()).not.toContain('EDIT');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(true);
    expect(rig.events).toEqual(['suspended']);
  });

  test('repeated keystrokes under no demand cost no parses and suspend only once', () => {
    rig = makeRig(() => false);
    for (let i = 0; i < 10; i++) typeInSource(rig, ` E${i}`);

    expect(rig.parses()).toBe(0);
    // The ledger is edge-triggered: ten skipped derives are one suspension.
    expect(rig.events).toEqual(['suspended']);
  });

  test('bounded: when demand returns, the next edit derives and clears the suspension', () => {
    let demand = false;
    rig = makeRig(() => demand);

    typeInSource(rig, ' WHILE_QUIET');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(true);
    expect(rig.parses()).toBe(0);

    demand = true;
    typeInSource(rig, ' AFTER_OPEN');

    expect(rig.parses()).toBeGreaterThan(0);
    // The catch-up absorbs BOTH edits — the one made while suspended and the
    // one that lifted the suspension. A catch-up that only carried the latest
    // keystroke would silently drop the quiet-window content from the WYSIWYG.
    const md = rig.fragmentMd();
    expect(md).toContain('WHILE_QUIET');
    expect(md).toContain('AFTER_OPEN');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(false);
    expect(rig.events).toEqual(['suspended', 'resumed']);
  });

  test('bounded with no further edit: resumeFragmentDerive pays the catch-up', () => {
    // The case the awareness listener exists for: a reader opens the WYSIWYG on
    // a document that has gone quiet, so no drain is coming to repair it.
    let demand = false;
    rig = makeRig(() => demand);

    typeInSource(rig, ' QUIET_EDIT');
    expect(rig.fragmentMd()).not.toContain('QUIET_EDIT');

    demand = true;
    resumeFragmentDerive(rig.doc);

    expect(rig.fragmentMd()).toContain('QUIET_EDIT');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(false);
    expect(rig.events).toEqual(['suspended', 'resumed']);
  });

  test('resumeFragmentDerive is a no-op when nothing is owed', () => {
    rig = makeRig(() => true);
    const before = rig.parses();

    resumeFragmentDerive(rig.doc);

    expect(rig.parses()).toBe(before);
    expect(rig.events).toEqual([]);
  });

  test('detach clears the suspension — an unobserved doc is nobody to alarm about', () => {
    // A doc left flagged after its observers are gone would suppress the
    // watchdog for a fragment nothing is deriving: suppression without a
    // bounding catch-up, which is exactly what must not happen.
    rig = makeRig(() => false);
    typeInSource(rig, ' EDIT');
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(true);

    rig.cleanup();
    expect(isFragmentDeriveSuspended(rig.doc)).toBe(false);

    const finished = rig;
    rig = undefined; // already cleaned up; keep afterEach from double-calling
    expect(finished.doc.isDestroyed).toBe(false);
  });
});
