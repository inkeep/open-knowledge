
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

function lostLines(trip: Trip): string[] {
  return detectPairedIntakeLoss(trip.obs);
}

async function openDoc(docName: string): Promise<Y.Doc> {
  const conn = await hp.openDirectConnection(docName);
  const doc = (conn as unknown as { document: Y.Doc }).document;
  if (!doc) throw new Error('DirectConnection has no document');
  applyExternalChange(durabilityState, hp, docName, BASE);
  return doc;
}

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
    expect(trips.length).toBeGreaterThanOrEqual(1);
    expect(trips.every((t) => t.site === DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE)).toBe(true);
    const withLoss = trips.filter((t) => lostLines(t).length > 0);
    expect(withLoss).toEqual([]);
  });

  test('a DIRTY open doc trips site=file-watcher-intake naming the un-propagated line', async () => {
    const docName = 'watcher-dirty';
    const doc = await openDoc(docName);
    stagePendingFragmentLine(doc, PENDING);
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
    expect(doc.getText('source').toString()).toContain('disk-authored line');
  });

  test('with no reporter wired the intake stays serialize-free and silent', async () => {
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

      expect(unwiredSerializes).toBe(0);
      expect(wiredSerializes).toBeGreaterThan(unwiredSerializes);
      expect(trips.length).toBeGreaterThanOrEqual(1);
      expect(unwiredDoc.getText('source').toString()).toContain('disk-authored line');
      expect(wiredDoc.getText('source').toString()).toContain('disk-authored line');
    } finally {
      spy.mockRestore();
    }
  });

  test('a byte-identical re-apply over a clean doc reports no loss', async () => {
    const docName = 'watcher-identical';
    await openDoc(docName);
    trips.length = 0;

    applyExternalChange(durabilityState, hp, docName, BASE, undefined, undefined, reporter);

    expect(trips.length).toBeGreaterThanOrEqual(1);
    expect(trips.filter((t) => lostLines(t).length > 0)).toEqual([]);
  });
});
