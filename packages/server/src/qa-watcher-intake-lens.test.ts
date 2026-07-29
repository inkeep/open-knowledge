/**
 * Behavioral adjudication of the disk-intake loss detector.
 *
 * `bridge-loss-suppression.test.ts` is a static registry sweep: it proves every
 * paired origin carries a detect/suppress classification, not that the
 * classification produces the right RUNTIME behavior. Nothing anywhere drives
 * `applyExternalChange` with a dirty fragment, so the required dirty-open-doc
 * positive (`site: 'file-watcher-intake'`) is asserted at no rung — the
 * detector-trip constant is referenced only by direct `reporter(...)` calls in
 * the detector's own unit test, never through the intake path that ships it.
 *
 * This also settles the branch-switch question. A branch switch resets each
 * open doc through the SAME call this exercises — `applyToDoc` in
 * `server-factory.ts` is a thin wrapper over `applyExternalChange` under
 * `FILE_WATCHER_ORIGIN`, which the registry classifies `detect` — so the
 * clean/dirty split measured here is the branch-switch behavior too: a clean
 * open doc cannot false-positive, and a dirty one trips because the user's
 * un-propagated editor content really is about to be rebuilt away.
 *
 */

import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import type { DeriveLossObservation } from './bridge-loss-detector.ts';
import {
  DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
  detectPairedIntakeLoss,
} from './bridge-loss-detector.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { applyExternalChange } from './external-change.ts';
import { mdManager } from './md-manager.ts';

const BASE = '# Notes\n\nsettled body line\n';
const NEXT_FROM_DISK = '# Notes\n\nsettled body line\n\ndisk-authored line\n';
const PENDING = 'un-propagated keystroke line';

interface Trip {
  docName: string;
  obs: DeriveLossObservation;
  writerId?: string | null;
  site?: string;
}

let hp: Hocuspocus;
let durabilityState: DocumentDurabilityState;
let trips: Trip[];

beforeEach(() => {
  hp = new Hocuspocus({ quiet: true });
  durabilityState = new DocumentDurabilityState();
  trips = [];
});
afterEach(() => {
  trips = [];
});

const reporter = (
  docName: string,
  obs: DeriveLossObservation,
  writerId?: string | null,
  site?: string,
) => {
  trips.push({ docName, obs, writerId, site });
};

/** Lines the detector judges lost for a recorded trip. */
function lostLines(trip: Trip): string[] {
  return detectPairedIntakeLoss(trip.obs);
}

async function openDoc(docName: string): Promise<Y.Doc> {
  const conn = await hp.openDirectConnection(docName);
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  // Establish a settled bridge state through the shipped intake path.
  applyExternalChange(durabilityState, hp, docName, BASE);
  return doc;
}

/** Append a paragraph to the fragment WITHOUT touching Y.Text — a dirty doc. */
function stagePendingFragmentLine(doc: Y.Doc, text: string): void {
  const frag = doc.getXmlFragment('default');
  const para = new Y.XmlElement('paragraph');
  para.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [para]);
}

describe('disk intake through applyExternalChange (the branch-switch reset path)', () => {
  test('a CLEAN open doc converges with no detector trip (no false positive)', async () => {
    const docName = 'watcher-clean';
    const doc = await openDoc(docName);
    trips.length = 0;

    applyExternalChange(
      durabilityState,
      hp,
      docName,
      NEXT_FROM_DISK,
      undefined,
      undefined,
      reporter,
    );

    expect(doc.getText('source').toString()).toContain('disk-authored line');
    // PRECONDITION — the detector actually RAN on this intake. Without it, "no
    // trip carried lost lines" is satisfied by the reporter never being wired
    // at all, so deleting the `detect` construction in `applyExternalChange`
    // would leave this arm green.
    expect(trips.length).toBeGreaterThanOrEqual(1);
    expect(trips.every((t) => t.site === DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE)).toBe(true);
    const withLoss = trips.filter((t) => lostLines(t).length > 0);
    expect(withLoss).toEqual([]);
  });

  test('a DIRTY open doc trips site=file-watcher-intake naming the un-propagated line', async () => {
    const docName = 'watcher-dirty';
    const doc = await openDoc(docName);
    stagePendingFragmentLine(doc, PENDING);
    // Precondition: the fragment really does hold content Y.Text does not.
    expect(doc.getText('source').toString()).not.toContain(PENDING);
    trips.length = 0;

    applyExternalChange(
      durabilityState,
      hp,
      docName,
      NEXT_FROM_DISK,
      undefined,
      undefined,
      reporter,
    );

    const losses = trips.filter((t) => lostLines(t).length > 0);
    expect(losses.length).toBeGreaterThanOrEqual(1);
    const trip = losses[0];
    expect(trip?.site).toBe(DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE);
    expect(trip?.docName).toBe(docName);
    expect(lostLines(trip as Trip)).toContain(PENDING);
    // The disk write still lands — detection observes the loss, it does not veto.
    expect(doc.getText('source').toString()).toContain('disk-authored line');
  });

  test('with no reporter wired the intake stays serialize-free and silent', async () => {
    // `expect(trips).toEqual([])` alone is true by construction — nothing can
    // push to `trips` when no reporter is handed in. The claim with teeth is the
    // SERIALIZE-FREE half: the detector's four canonicalizing serializes
    // (pendingBody, rebuiltBody, ytextDerivedBody, baselineBody) must be paid
    // only when a detector is wired. Measure the same staging both ways.
    const spy = vi.spyOn(mdManager, 'serialize');
    try {
      const unwiredDoc = await openDoc('watcher-no-reporter');
      stagePendingFragmentLine(unwiredDoc, PENDING);
      trips.length = 0;
      spy.mockClear();
      applyExternalChange(durabilityState, hp, 'watcher-no-reporter', NEXT_FROM_DISK);
      const unwiredSerializes = spy.mock.calls.length;

      const wiredDoc = await openDoc('watcher-with-reporter');
      stagePendingFragmentLine(wiredDoc, PENDING);
      trips.length = 0;
      spy.mockClear();
      applyExternalChange(
        durabilityState,
        hp,
        'watcher-with-reporter',
        NEXT_FROM_DISK,
        undefined,
        undefined,
        reporter,
      );
      const wiredSerializes = spy.mock.calls.length;

      // Off costs nothing extra; on pays for the canonicalization it needs.
      expect(unwiredSerializes).toBe(0);
      expect(wiredSerializes).toBeGreaterThan(unwiredSerializes);
      // ...and the differential really is the detector: the wired run tripped.
      expect(trips.length).toBeGreaterThanOrEqual(1);
      // Both land the disk write regardless of whether anyone is watching.
      expect(unwiredDoc.getText('source').toString()).toContain('disk-authored line');
      expect(wiredDoc.getText('source').toString()).toContain('disk-authored line');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * A byte-identical re-apply — the shape a branch switch produces when the doc
   * is the same on both branches — must not manufacture a loss verdict.
   *
   */
  test('a byte-identical re-apply over a clean doc reports no loss', async () => {
    const docName = 'watcher-identical';
    await openDoc(docName);
    trips.length = 0;

    applyExternalChange(durabilityState, hp, docName, BASE, undefined, undefined, reporter);

    // Same precondition as the clean arm: the detector ran and returned a
    // no-loss verdict, rather than never having been consulted.
    expect(trips.length).toBeGreaterThanOrEqual(1);
    expect(trips.filter((t) => lostLines(t).length > 0)).toEqual([]);
  });
});
