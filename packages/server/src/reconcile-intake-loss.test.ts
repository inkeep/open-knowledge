import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type * as Y from 'yjs';
import {
  type BridgeDeriveLossReporter,
  DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
  type DeriveLossObservation,
  detectPairedIntakeLoss,
} from './bridge-loss-detector.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { reconcileDiskBeforeAgentWrite } from './external-change.ts';
import { mdManager } from './md-manager.ts';

const schema = getSchema(sharedExtensions);

const BASE = '# Notes\n\nFirst paragraph.\n';
const DISK_EDIT = '# Notes\n\nFirst paragraph, edited on disk.\n';
const PENDING_LINE = 'A keystroke that never reached Y.Text.';

interface Trip {
  docName: string;
  obs: DeriveLossObservation;
  writerId?: string | null;
  site?: string;
}

describe('reconcileDiskBeforeAgentWrite paired-intake instrumentation', () => {
  let hp: Hocuspocus;
  let durabilityState: DocumentDurabilityState;
  let contentDir: string;

  beforeEach(() => {
    hp = new Hocuspocus({ quiet: true });
    durabilityState = new DocumentDurabilityState();
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reconcile-intake-')));
  });
  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('a divergent disk edit ingested over a dirty open doc reports the derive loss', async () => {
    const docName = 'dirty-reconcile';
    const conn = await hp.openDirectConnection(docName);
    const doc = (conn as unknown as { document: Y.Doc }).document;
    try {
      writeFileSync(join(contentDir, `${docName}.md`), BASE);
      durabilityState.setReconciledBase(docName, BASE);
      doc.transact(() => {
        doc.getText('source').insert(0, BASE);
        updateYFragment(
          doc,
          doc.getXmlFragment('default'),
          schema.nodeFromJSON(mdManager.parse(BASE)),
          { mapping: new Map(), isOMark: new Map() },
        );
      }, 'test-seed');

      doc.transact(() => {
        updateYFragment(
          doc,
          doc.getXmlFragment('default'),
          schema.nodeFromJSON(mdManager.parse(`${BASE}\n${PENDING_LINE}\n`)),
          { mapping: new Map(), isOMark: new Map() },
        );
      }, 'test-wysiwyg');
      expect(doc.getText('source').toString()).not.toContain(PENDING_LINE);

      writeFileSync(join(contentDir, `${docName}.md`), DISK_EDIT);

      const trips: Trip[] = [];
      const reporter: BridgeDeriveLossReporter = (name, obs, writerId, site) => {
        trips.push({ docName: name, obs, writerId, site });
      };

      const result = reconcileDiskBeforeAgentWrite(
        durabilityState,
        hp,
        docName,
        contentDir,
        undefined,
        reporter,
      );

      expect(result.reconciled).toBe(true);
      expect(doc.getText('source').toString()).toContain('edited on disk');

      expect(trips.length).toBe(1);
      const trip = trips[0];
      expect(trip?.docName).toBe(docName);
      expect(trip?.site).toBe(DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE);
      expect(trip?.obs.pendingBody).toContain(PENDING_LINE);
      const dropped = trip ? detectPairedIntakeLoss(trip.obs) : [];
      expect(dropped.join('\n')).toContain(PENDING_LINE);
      expect(trip?.obs.restorePayload).toContain(PENDING_LINE);
    } finally {
      await conn.disconnect();
    }
  });

  test('a clean open doc reconciles without a spurious trip', async () => {
    const docName = 'clean-reconcile';
    const conn = await hp.openDirectConnection(docName);
    const doc = (conn as unknown as { document: Y.Doc }).document;
    try {
      writeFileSync(join(contentDir, `${docName}.md`), BASE);
      durabilityState.setReconciledBase(docName, BASE);
      doc.transact(() => {
        doc.getText('source').insert(0, BASE);
        updateYFragment(
          doc,
          doc.getXmlFragment('default'),
          schema.nodeFromJSON(mdManager.parse(BASE)),
          { mapping: new Map(), isOMark: new Map() },
        );
      }, 'test-seed');
      writeFileSync(join(contentDir, `${docName}.md`), DISK_EDIT);

      const trips: Trip[] = [];
      const result = reconcileDiskBeforeAgentWrite(
        durabilityState,
        hp,
        docName,
        contentDir,
        undefined,
        (name, obs, writerId, site) => trips.push({ docName: name, obs, writerId, site }),
      );

      expect(result.reconciled).toBe(true);
      for (const trip of trips) {
        expect(detectPairedIntakeLoss(trip.obs)).toEqual([]);
      }
    } finally {
      await conn.disconnect();
    }
  });
});
