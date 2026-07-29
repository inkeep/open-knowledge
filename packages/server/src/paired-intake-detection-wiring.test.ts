/**
 * `PAIRED_INTAKE_DETECTION` is load-bearing at every wired intake, not
 * decoration.
 *
 * The registry declares, per paired-write origin, whether that origin's intake
 * derive runs the content-loss post-condition. A site that decides on reporter
 * presence alone still LOOKS correct while the registry says `detect` — the
 * divergence only surfaces the day someone reclassifies an origin to `suppress`
 * and nothing changes. These tests flip each classification at runtime and
 * assert the wired site actually follows it, so the registry cannot silently
 * become advisory at any one site.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import {
  type BridgeDeriveLossReporter,
  type DeriveLossObservation,
  detectPairedIntakeLoss,
} from './bridge-loss-detector.ts';
import {
  PAIRED_INTAKE_DETECTION,
  type PairedIntakeDetectionMode,
} from './bridge-loss-suppression.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { reconcileDiskBeforeAgentWrite } from './external-change.ts';
import { mdManager } from './md-manager.ts';
import { createWiredPreDrainRig, WIRED_PENDING_LINE } from './pre-drain-wired.test-helper.ts';

const schema = getSchema(sharedExtensions);

/** Run `fn` with one origin temporarily reclassified, then restore. */
function withMode(origin: string, mode: PairedIntakeDetectionMode, fn: () => void): void;
function withMode(
  origin: string,
  mode: PairedIntakeDetectionMode,
  fn: () => Promise<void>,
): Promise<void>;
function withMode(
  origin: string,
  mode: PairedIntakeDetectionMode,
  fn: () => void | Promise<void>,
): void | Promise<void> {
  const entry = PAIRED_INTAKE_DETECTION[origin];
  if (!entry) throw new Error(`unclassified paired origin: ${origin}`);
  const previous = entry.mode;
  entry.mode = mode;
  const restore = () => {
    entry.mode = previous;
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

/** Collect only OBSERVATIONS that actually carry a loss verdict. */
function lossCollector(): { trips: DeriveLossObservation[]; reporter: BridgeDeriveLossReporter } {
  const trips: DeriveLossObservation[] = [];
  return {
    trips,
    reporter: (_docName, obs) => {
      if (detectPairedIntakeLoss(obs).length > 0) trips.push(obs);
    },
  };
}

describe('paired-intake detection follows the registry at every wired site', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('agent-undo: reclassifying to suppress actually stops the undo-derive detection', async () => {
    // Baseline: classified `detect`, so the undo derive over an un-propagated
    // keystroke trips. (Pre-drain off so the content reaches the floor rather
    // than being flushed to safety first.)
    const on = lossCollector();
    const rigOn = await createWiredPreDrainRig({
      docName: 'undo-detect.md',
      reporter: on.reporter,
      setupOverrides: { preDrainEnabled: false },
    });
    try {
      rigOn.agentWrite('Agent appended line.', 'append');
      rigOn.stageUnpropagatedKeystroke();
      expect(rigOn.serializeFragment()).toContain(WIRED_PENDING_LINE);
      rigOn.agentUndo('last');
      expect(on.trips.length).toBeGreaterThan(0);
    } finally {
      await rigOn.cleanup();
    }

    const off = lossCollector();
    const rigOff = await createWiredPreDrainRig({
      docName: 'undo-suppress.md',
      reporter: off.reporter,
      setupOverrides: { preDrainEnabled: false },
    });
    try {
      await withMode('agent-undo', 'suppress', async () => {
        rigOff.agentWrite('Agent appended line.', 'append');
        rigOff.stageUnpropagatedKeystroke();
        expect(rigOff.serializeFragment()).toContain(WIRED_PENDING_LINE);
        rigOff.agentUndo('last');
      });
      expect(off.trips).toEqual([]);
    } finally {
      await rigOff.cleanup();
    }
  });

  test('agent-write: reclassifying to suppress actually stops the write-intake detection', async () => {
    const on = lossCollector();
    const rigOn = await createWiredPreDrainRig({
      docName: 'write-detect.md',
      reporter: on.reporter,
      setupOverrides: { preDrainEnabled: false },
    });
    try {
      rigOn.stageUnpropagatedKeystroke();
      rigOn.agentWrite('## Replaced\n\nBrand new body.\n', 'replace');
      expect(on.trips.length).toBeGreaterThan(0);
    } finally {
      await rigOn.cleanup();
    }

    const off = lossCollector();
    const rigOff = await createWiredPreDrainRig({
      docName: 'write-suppress.md',
      reporter: off.reporter,
      setupOverrides: { preDrainEnabled: false },
    });
    try {
      await withMode('agent-write', 'suppress', async () => {
        rigOff.stageUnpropagatedKeystroke();
        rigOff.agentWrite('## Replaced\n\nBrand new body.\n', 'replace');
      });
      expect(off.trips).toEqual([]);
    } finally {
      await rigOff.cleanup();
    }
  });

  test('file-watcher: reclassifying to suppress actually stops the reconcile-intake detection', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-registry-wiring-')));
    const hp = new Hocuspocus({ quiet: true });
    const durabilityState = new DocumentDurabilityState();
    const base = '# Notes\n\nFirst paragraph.\n';
    const pending = 'A keystroke that never reached Y.Text.';

    const seed = async (docName: string): Promise<Y.Doc> => {
      const conn = await hp.openDirectConnection(docName);
      const doc = (conn as unknown as { document: Y.Doc }).document;
      writeFileSync(join(contentDir, `${docName}.md`), base);
      durabilityState.setReconciledBase(docName, base);
      doc.transact(() => {
        doc.getText('source').insert(0, base);
        updateYFragment(
          doc,
          doc.getXmlFragment('default'),
          schema.nodeFromJSON(mdManager.parse(base)),
          { mapping: new Map(), isOMark: new Map() },
        );
      }, 'seed');
      doc.transact(() => {
        updateYFragment(
          doc,
          doc.getXmlFragment('default'),
          schema.nodeFromJSON(mdManager.parse(`${base}\n${pending}\n`)),
          { mapping: new Map(), isOMark: new Map() },
        );
      }, 'wysiwyg');
      writeFileSync(join(contentDir, `${docName}.md`), '# Notes\n\nEdited on disk.\n');
      return doc;
    };

    try {
      const on = lossCollector();
      await seed('watcher-detect');
      reconcileDiskBeforeAgentWrite(
        durabilityState,
        hp,
        'watcher-detect',
        contentDir,
        undefined,
        on.reporter,
      );
      expect(on.trips.length).toBeGreaterThan(0);

      const off = lossCollector();
      await seed('watcher-suppress');
      withMode('file-watcher', 'suppress', () => {
        reconcileDiskBeforeAgentWrite(
          durabilityState,
          hp,
          'watcher-suppress',
          contentDir,
          undefined,
          off.reporter,
        );
      });
      expect(off.trips).toEqual([]);
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });
});
