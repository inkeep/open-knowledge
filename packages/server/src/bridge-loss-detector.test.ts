/**
 * Observer-B (Y.Text→XmlFragment) derive-loss detection.
 *
 * Covers the pure twin verdict, the observation a real `deriveFragmentFromYtext`
 * produces when the fragment holds content Y.Text lacks, and the reporter that
 * writes a `bridge-derive-loss` checkpoint + content-free `detector-trip` ring
 * event through real shadow git.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  normalizeBridge,
  pendingContentLines,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { updateYFragment } from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  composeAndWriteRawBody,
  deriveFragmentFromYtext,
  replaceRawBody,
} from './bridge-intake.ts';
import {
  createBridgeDeriveLossReporter,
  DERIVE_LOSS_SITE_AGENT_UNDO,
  DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE,
  DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE,
  type DeriveLossObservation,
  detectApplyArmDrop,
  detectDeriveLoss,
  detectPairedIntakeLoss,
} from './bridge-loss-detector.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { applyExternalChange } from './external-change.ts';
import { LossCaptureRing, lossCaptureCurrentPath, parseLossCaptureLines } from './loss-capture.ts';
import { mdManager, schema } from './md-manager.ts';
import { setupServerObservers } from './server-observers.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

type RingEvent = ReturnType<typeof parseLossCaptureLines>[number];

/** Poll the loss ring until an event matching `predicate` appears (bounded). */
async function pollForEvent(
  projectDir: string,
  ring: LossCaptureRing,
  predicate: (e: RingEvent) => boolean,
  timeoutMs = 5000,
): Promise<RingEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await ring.drain();
    try {
      const events = parseLossCaptureLines(
        readFileSync(lossCaptureCurrentPath(projectDir), 'utf-8'),
      );
      const found = events.find(predicate);
      if (found) return found;
    } catch {
      // Ring file not written yet.
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for loss-ring event');
}

function buildFragment(doc: Y.Doc, body: string): void {
  const xf = doc.getXmlFragment('default');
  const pm = schema.nodeFromJSON(mdManager.parseWithFallback(body, undefined));
  doc.transact(() => updateYFragment(doc, xf, pm, { mapping: new Map(), isOMark: new Map() }));
}

/** A doc whose fragment holds `pendingBody` while Y.Text still holds `syncedMd`. */
function seedDivergedDoc(syncedMd: string, pendingBody: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, syncedMd);
  // Fragment first materialized in sync, then advanced with the pending edit —
  // Y.Text is left untouched, so the fragment holds content Y.Text lacks.
  buildFragment(doc, stripFrontmatter(syncedMd).body);
  buildFragment(doc, pendingBody);
  return doc;
}

describe('detectDeriveLoss (the twin verdict)', () => {
  it('flags a never-propagated fragment line that both twins lack', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      // The keystroke was never in Y.Text before the op.
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
  });

  it('does NOT flag content the operation legitimately removed (an intended undo)', () => {
    // The undone line WAS in the pre-op Y.Text (propagated), so the undo
    // removing it is intended — not a loss. This is the fuzz-caught regression.
    const obs: DeriveLossObservation = {
      pendingBody: 'Line A\n\nLine B',
      baselineBody: 'Line A\n\nLine B',
      ytextDerivedBody: 'Line A',
      rebuiltBody: 'Line A',
      restorePayload: 'Line A\n\nLine B',
    };
    expect(detectDeriveLoss(obs)).toEqual([]);
  });

  it('returns empty when the rebuild preserved the at-risk content', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nKept line',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body\n\nKept line',
      rebuiltBody: 'Shared body\n\nKept line',
      restorePayload: 'Shared body\n\nKept line',
    };
    expect(detectDeriveLoss(obs)).toEqual([]);
  });

  it('catches a loss via the independent twin when one representation is blind', () => {
    // Planted producer-side blindness: the rebuilt live fragment still shows the
    // content (as if updateYFragment silently kept it), so the producer check
    // reports nothing — but the ytext-derived twin catches the real drop.
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body\n\nPending keystroke',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
  });
});

describe('deriveFragmentFromYtext observation', () => {
  it('reports the un-propagated fragment content the derive discards', () => {
    const doc = seedDivergedDoc(
      '# Title\n\nOriginal line',
      '# Title\n\nOriginal line\n\nPending keystroke',
    );
    let captured: DeriveLossObservation | undefined;
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        report: (obs) => {
          captured = obs;
        },
        baselineFullMd,
      });
    });
    expect(captured).toBeDefined();
    const dropped = detectDeriveLoss(captured as DeriveLossObservation);
    expect(dropped).toContain('Pending keystroke');
    // The restore payload carries the pending content so it stays recoverable.
    expect((captured as DeriveLossObservation).restorePayload).toContain('Pending keystroke');
    doc.destroy();
  });

  it('reports no loss for an ordinary in-sync derive', () => {
    const md = '# Title\n\nOnly line';
    const doc = new Y.Doc();
    doc.getText('source').insert(0, md);
    buildFragment(doc, stripFrontmatter(md).body);
    let captured: DeriveLossObservation | undefined;
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        report: (obs) => {
          captured = obs;
        },
        baselineFullMd,
      });
    });
    expect(captured).toBeDefined();
    expect(detectDeriveLoss(captured as DeriveLossObservation)).toEqual([]);
    doc.destroy();
  });
});

describe('createBridgeDeriveLossReporter (real shadow + ring)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-derive-loss-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupShadow(): Promise<{ projectRoot: string; shadow: ShadowHandle }> {
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    return { projectRoot, shadow };
  }

  it('writes a bridge-derive-loss checkpoint + detector-trip event whose sha resolves', async () => {
    const { projectRoot, shadow } = await setupShadow();
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
    const reporter = createBridgeDeriveLossReporter({
      shadow: () => shadow,
      ring,
      getBranch: () => 'main',
      contentRoot: '',
    });

    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        report: (obs) => reporter('intro', obs, 'agent-1'),
        baselineFullMd,
      });
    });
    doc.destroy();

    // The checkpoint write is a real git commit; the sha-bearing ring event is
    // written from its `.then`. Poll until it lands.
    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) => e.event === 'detector-trip' && Boolean(e.checkpointSha),
    );
    expect(trip).toBeDefined();
    expect(trip?.direction).toBe('b');
    expect(trip?.docName).toBe('intro');
    // Content-free: a length + a digest, never the bytes.
    expect(typeof trip?.lostLen).toBe('number');
    expect(trip?.digest).toBeTruthy();

    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    const row = hist.entries.find((e) => e.sha === trip?.checkpointSha);
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  });

  it('writes nothing when the derive preserved all content', async () => {
    const { projectRoot, shadow } = await setupShadow();
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
    const reporter = createBridgeDeriveLossReporter({
      shadow: () => shadow,
      ring,
      getBranch: () => 'main',
      contentRoot: '',
    });

    const md = '# Title\n\nOnly line';
    const doc = new Y.Doc();
    doc.getText('source').insert(0, md);
    buildFragment(doc, stripFrontmatter(md).body);
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        report: (obs) => reporter('intro', obs),
        baselineFullMd,
      });
    });
    doc.destroy();

    await new Promise((r) => setTimeout(r, 0));
    await ring.drain();

    let events: ReturnType<typeof parseLossCaptureLines> = [];
    try {
      events = parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
    } catch {
      // No ring file written at all is also a pass.
    }
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(hist.entries.some((e) => e.checkpoint?.kind === 'bridge-derive-loss')).toBe(false);
  });
});

describe('detectApplyArmDrop (Observer-A apply verdict)', () => {
  it('flags a substantive line the applied Y.Text dropped', () => {
    const md = '# Title\n\nLine one\n\nLine two\n\nLine three';
    const applied = '# Title\n\nLine one\n\nLine three';
    expect(detectApplyArmDrop(md, normalizeBridge(md), applied, normalizeBridge(applied))).toEqual([
      'Line two',
    ]);
  });

  it('returns empty for a byte-identical apply', () => {
    const md = '# Title\n\nBody line';
    expect(detectApplyArmDrop(md, normalizeBridge(md), md, normalizeBridge(md))).toEqual([]);
  });

  it('does not flag a normalization-only difference (raw vs canonical form)', () => {
    // The byte-preserving splice legitimately leaves the raw multi-blank form in
    // Y.Text while the fragment serializes to the single-blank canonical form.
    const canonical = 'A paragraph\n\nAnother paragraph';
    const raw = 'A paragraph\n\n\n\nAnother paragraph';
    // Precondition: normalize-equal — a tolerance difference, not a loss.
    expect(normalizeBridge(raw)).toBe(normalizeBridge(canonical));
    expect(
      detectApplyArmDrop(canonical, normalizeBridge(canonical), raw, normalizeBridge(raw)),
    ).toEqual([]);
  });
});

describe('Observer-A apply post-condition (real drain)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-apply-loss-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Delete `target` from Y.Text once — models an apply arm dropping content. */
  function makeInjector(target: string): (yt: Y.Text) => void {
    let fired = false;
    return (yt) => {
      if (fired) return;
      const idx = yt.toString().indexOf(target);
      if (idx >= 0) {
        yt.delete(idx, target.length);
        fired = true;
      }
    };
  }

  it('checkpoints + emits a detector-trip when an apply arm drops content', async () => {
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });

    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xf = doc.getXmlFragment('default');
    ytext.insert(0, '# Title\n\nLine one\n\nLine two');
    buildFragment(doc, '# Title\n\nLine one\n\nLine two');

    const cleanup = setupServerObservers({
      doc,
      xmlFragment: xf,
      ytext,
      mdManager,
      schema,
      docName: 'intro',
      shadow: () => shadow,
      getBranch: () => 'main',
      contentRoot: '',
      lossDetectorEnabled: true,
      lossRing: ring,
      __testApplyLossInjector: makeInjector('Line two'),
    });

    // Edit the fragment (adds a line) to drive an Observer-A apply drain; the
    // injector then drops "Line two" from the applied Y.Text.
    buildFragment(doc, '# Title\n\nLine one\n\nLine two\n\nLine three');

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) => e.event === 'detector-trip' && e.direction === 'a' && Boolean(e.checkpointSha),
    );
    expect(trip.docName).toBe('intro');
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        // Its OWN kind, not Path B's — the two detection sites stay
        // distinguishable by kind, counter, and retention budget.
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'observer-a-apply-loss',
      ),
    ).toBe(true);

    cleanup();
    doc.destroy();
  });

  it('does not trip when the loss-detector kill-switch is off', async () => {
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });

    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const xf = doc.getXmlFragment('default');
    ytext.insert(0, '# Title\n\nLine one\n\nLine two');
    buildFragment(doc, '# Title\n\nLine one\n\nLine two');

    const cleanup = setupServerObservers({
      doc,
      xmlFragment: xf,
      ytext,
      mdManager,
      schema,
      docName: 'intro',
      shadow: () => shadow,
      getBranch: () => 'main',
      contentRoot: '',
      lossDetectorEnabled: false,
      lossRing: ring,
      __testApplyLossInjector: makeInjector('Line two'),
    });

    buildFragment(doc, '# Title\n\nLine one\n\nLine two\n\nLine three');

    await new Promise((r) => setTimeout(r, 100));
    await ring.drain();
    let events: RingEvent[] = [];
    try {
      events = parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
    } catch {
      // No ring file is also a pass.
    }
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);

    cleanup();
    doc.destroy();
  });
});

describe('paired-intake derive-loss (composeAndWriteRawBody / replaceRawBody, real shadow + ring)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-paired-intake-loss-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupReporter(): Promise<{
    projectRoot: string;
    shadow: ShadowHandle;
    ring: LossCaptureRing;
    reporter: ReturnType<typeof createBridgeDeriveLossReporter>;
  }> {
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
    const reporter = createBridgeDeriveLossReporter({
      shadow: () => shadow,
      ring,
      getBranch: () => 'main',
      contentRoot: '',
    });
    return { projectRoot, shadow, ring, reporter };
  }

  async function assertNoTrip(projectRoot: string, ring: LossCaptureRing): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await ring.drain();
    let events: RingEvent[] = [];
    try {
      events = parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
    } catch {
      // No ring file is also a pass.
    }
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);
  }

  it('file-watcher intake: a disk write that drops un-propagated fragment content trips + checkpoints', async () => {
    const { projectRoot, shadow, ring, reporter } = await setupReporter();
    // Dirty open doc: the fragment holds a keystroke Y.Text never absorbed.
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      composeAndWriteRawBody(
        doc,
        '# Title\n\nOriginal edited on disk',
        'file-watcher',
        undefined,
        undefined,
        {
          report: (obs) =>
            reporter('intro', obs, 'file-system', DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE),
          baselineFullMd,
        },
      );
    });
    doc.destroy();

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE &&
        Boolean(e.checkpointSha),
    );
    expect(trip.direction).toBe('b');
    expect(trip.docName).toBe('intro');
    expect(trip.writerId).toBe('file-system');
    // Content-free: a length + a digest, never the bytes.
    expect(typeof trip.lostLen).toBe('number');
    expect(trip.digest).toBeTruthy();
    expect(JSON.stringify(trip)).not.toContain('Pending keystroke');

    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    const row = hist.entries.find((e) => e.sha === trip.checkpointSha);
    expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
  });

  it('file-watcher intake: a clean doc (fragment == Y.Text) does not trip', async () => {
    const { projectRoot, ring, reporter } = await setupReporter();
    const md = '# Title\n\nOnly line';
    const doc = new Y.Doc();
    doc.getText('source').insert(0, md);
    buildFragment(doc, stripFrontmatter(md).body);
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      composeAndWriteRawBody(
        doc,
        '# Title\n\nOnly line edited',
        'file-watcher',
        undefined,
        undefined,
        {
          report: (obs) =>
            reporter('intro', obs, 'file-system', DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE),
          baselineFullMd,
        },
      );
    });
    doc.destroy();
    await assertNoTrip(projectRoot, ring);
  });

  it('agent-write intake (replaceRawBody): an overwrite that drops un-propagated content trips with the agent-write site', async () => {
    const { projectRoot, shadow, ring, reporter } = await setupReporter();
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      replaceRawBody(doc, '# Title\n\nAgent replacement', undefined, undefined, {
        report: (obs) => reporter('intro', obs, 'agent-1', DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE),
        baselineFullMd,
      });
    });
    doc.destroy();

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE &&
        Boolean(e.checkpointSha),
    );
    expect(trip.direction).toBe('b');
    expect(trip.writerId).toBe('agent-1');
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'bridge-derive-loss',
      ),
    ).toBe(true);
  });

  it('agent-write intake: an overwrite that keeps the pending content does not trip', async () => {
    const { projectRoot, ring, reporter } = await setupReporter();
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    const baselineFullMd = doc.getText('source').toString();
    doc.transact(() => {
      replaceRawBody(
        doc,
        '# Title\n\nOriginal\n\nPending keystroke\n\nAgent added',
        undefined,
        undefined,
        {
          report: (obs) => reporter('intro', obs, 'agent-1', DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE),
          baselineFullMd,
        },
      );
    });
    doc.destroy();
    await assertNoTrip(projectRoot, ring);
  });

  it('applyExternalChange builds + forwards the reporter and the file-watcher detector fires', async () => {
    const { projectRoot, shadow, ring, reporter } = await setupReporter();
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    // The file-watcher intake spine: applyExternalChange resolves the doc, builds
    // the paired-intake detect from the reporter (file-watcher is classified
    // `detect`), and threads it through applyDiskContentToDoc → the primitive.
    const hocuspocus = {
      documents: { get: (n: string) => (n === 'intro' ? doc : undefined) },
    } as unknown as Parameters<typeof applyExternalChange>[1];
    applyExternalChange(
      new DocumentDurabilityState(),
      hocuspocus,
      'intro',
      '# Title\n\nOriginal edited on disk',
      undefined,
      undefined,
      reporter,
    );

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE &&
        Boolean(e.checkpointSha),
    );
    expect(trip.direction).toBe('b');
    expect(trip.docName).toBe('intro');
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'bridge-derive-loss',
      ),
    ).toBe(true);
    doc.destroy();
  });

  it('a suppress-classified paired write (no detect option) never trips, even on a dirty fragment', async () => {
    // Rollback + managed-rename callers pass NO detect option — the structural
    // suppression the registry classifies. Even with a live reporter available,
    // a write that omits the detect option runs the detector for nobody.
    const { projectRoot, ring } = await setupReporter();
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    doc.transact(() => {
      // The rollback/rename shape: a full overwrite with no detect wired.
      replaceRawBody(doc, '# Title\n\nRolled back to an older version');
    });
    doc.destroy();
    await assertNoTrip(projectRoot, ring);
  });
});

describe('detectPairedIntakeLoss (the line-predicate floor)', () => {
  // The substring twin diffs inserted segments; a short intra-line delta that
  // coincidentally reappears in the write's new bytes is filtered out and the
  // twin reports nothing (the customer `bod`→`body.` shape). The line predicate
  // keys on whole raw lines, so the changed line — absent from both the target
  // derivation and the pre-operation baseline — is flagged.
  const INTRA_LINE_STOMP: DeriveLossObservation = {
    pendingBody: 'Deploy the staging server now.',
    baselineBody: 'Deploy the server now.',
    ytextDerivedBody: 'Restart the staging cluster later.',
    rebuiltBody: 'Restart the staging cluster later.',
    restorePayload: 'Deploy the staging server now.',
  };

  it('flags an intra-line stomp the substring twin filters away', () => {
    // The inserted "staging" reappears in the applied bytes, so the substring
    // twin's filter drops it — the twin alone is blind here.
    expect(detectDeriveLoss(INTRA_LINE_STOMP)).toEqual([]);
    // The floor catches it via the line predicate.
    expect(detectPairedIntakeLoss(INTRA_LINE_STOMP)).toContain('Deploy the staging server now.');
  });

  it('is a superset of the substring twin when the twin already catches the loss', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
    expect(detectPairedIntakeLoss(obs)).toContain('Pending keystroke');
  });

  it('does not flag an intended removal (the witness leg excludes it)', () => {
    // The line was in the pre-operation Y.Text, so removing it is intended — not
    // a never-propagated keystroke.
    const obs: DeriveLossObservation = {
      pendingBody: 'Line A\n\nLine B',
      baselineBody: 'Line A\n\nLine B',
      ytextDerivedBody: 'Line A',
      rebuiltBody: 'Line A',
      restorePayload: 'Line A\n\nLine B',
    };
    expect(detectPairedIntakeLoss(obs)).toEqual([]);
  });
});

describe('paired-intake floor through the real pipeline (real shadow + ring)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-paired-floor-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // An intra-line stomp: the fragment holds "Deploy the staging server now." while
  // Y.Text holds "Deploy the server now."; the write replaces the line with content
  // that reuses "staging", so only the line predicate catches the loss.
  const PRE_OP_BODY = '## Guide\n\nDeploy the server now.';
  const PENDING_BODY = '## Guide\n\nDeploy the staging server now.';
  const PENDING_LINE = 'Deploy the staging server now.';
  const REPLACEMENT = '## Guide\n\nRestart the staging cluster later.';

  async function setup(): Promise<{
    projectRoot: string;
    shadow: ShadowHandle;
    ring: LossCaptureRing;
    reporter: ReturnType<typeof createBridgeDeriveLossReporter>;
  }> {
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
    const reporter = createBridgeDeriveLossReporter({
      shadow: () => shadow,
      ring,
      getBranch: () => 'main',
      contentRoot: '',
    });
    return { projectRoot, shadow, ring, reporter };
  }

  it('agent-write (replaceRawBody): the line predicate trips + checkpoints an intra-line stomp the twin misses', async () => {
    const { projectRoot, shadow, ring, reporter } = await setup();
    const doc = seedDivergedDoc(PRE_OP_BODY, PENDING_BODY);
    const baselineFullMd = doc.getText('source').toString();
    let captured: DeriveLossObservation | undefined;
    doc.transact(() => {
      replaceRawBody(doc, REPLACEMENT, undefined, undefined, {
        report: (obs) => {
          captured = obs;
          reporter('intro', obs, 'agent-1', DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE);
        },
        baselineFullMd,
      });
    });
    doc.destroy();

    // The captured observation proves the line predicate — not the substring
    // twin — is what enables the trip through the real serialize pipeline.
    expect(captured).toBeDefined();
    const obs = captured as DeriveLossObservation;
    expect(detectDeriveLoss(obs)).toEqual([]);
    expect(detectPairedIntakeLoss(obs)).toContain(PENDING_LINE);

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE &&
        Boolean(e.checkpointSha),
    );
    expect(trip.direction).toBe('b');
    // Content-free ring: never the lost bytes.
    expect(JSON.stringify(trip)).not.toContain(PENDING_LINE);

    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'bridge-derive-loss',
      ),
    ).toBe(true);
  });

  it('the checkpoint payload is the pre-derive FRAGMENT serialization (byte-level), not Y.Text', async () => {
    const { projectRoot, shadow, ring, reporter } = await setup();
    const doc = seedDivergedDoc(PRE_OP_BODY, PENDING_BODY);
    const baselineFullMd = doc.getText('source').toString();
    let captured: DeriveLossObservation | undefined;
    doc.transact(() => {
      replaceRawBody(doc, REPLACEMENT, undefined, undefined, {
        report: (obs) => {
          captured = obs;
          reporter('intro', obs, 'agent-1', DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE);
        },
        baselineFullMd,
      });
    });
    doc.destroy();
    const obs = captured as DeriveLossObservation;

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) => e.event === 'detector-trip' && Boolean(e.checkpointSha),
    );
    const blob = (await shadowGit(shadow).raw('show', `${trip.checkpointSha}:intro`)).toString();

    // Byte-identical to the captured restore payload …
    expect(blob).toBe(obs.restorePayload);
    // … which carries the un-propagated fragment keystroke Y.Text never held …
    expect(blob).toContain(PENDING_LINE);
    // … and is NOT the Y.Text-derived content the write applied (a Y.Text payload
    // would miss the keystroke entirely).
    expect(blob).not.toContain('Restart the staging cluster');
  });

  it('file-watcher (composeAndWriteRawBody): the line predicate trips + checkpoints an intra-line stomp', async () => {
    const { projectRoot, shadow, ring, reporter } = await setup();
    const doc = seedDivergedDoc(PRE_OP_BODY, PENDING_BODY);
    const baselineFullMd = doc.getText('source').toString();
    let captured: DeriveLossObservation | undefined;
    doc.transact(() => {
      composeAndWriteRawBody(doc, REPLACEMENT, 'file-watcher', undefined, undefined, {
        report: (obs) => {
          captured = obs;
          reporter('intro', obs, 'file-system', DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE);
        },
        baselineFullMd,
      });
    });
    doc.destroy();
    const obs = captured as DeriveLossObservation;
    expect(detectDeriveLoss(obs)).toEqual([]);
    expect(detectPairedIntakeLoss(obs)).toContain(PENDING_LINE);

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE &&
        Boolean(e.checkpointSha),
    );
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'bridge-derive-loss',
      ),
    ).toBe(true);
  });

  it('agent-undo (deriveFragmentFromYtext): the line predicate participates in the floor for every derive caller', async () => {
    const { projectRoot, shadow, ring, reporter } = await setup();
    const doc = seedDivergedDoc(
      '## Guide\n\nOriginal.',
      '## Guide\n\nOriginal.\n\nPending line here.',
    );
    const baselineFullMd = doc.getText('source').toString();
    let captured: DeriveLossObservation | undefined;
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        report: (obs) => {
          captured = obs;
          reporter('intro', obs, 'agent-1', DERIVE_LOSS_SITE_AGENT_UNDO);
        },
        baselineFullMd,
      });
    });
    doc.destroy();
    const obs = captured as DeriveLossObservation;
    // The line predicate flags the un-propagated fragment line for the agent-undo
    // vector too — the floor covers every deriveFragmentFromYtext caller.
    expect(pendingContentLines(obs.pendingBody, obs.ytextDerivedBody, obs.baselineBody)).toContain(
      'Pending line here.',
    );
    expect(detectPairedIntakeLoss(obs)).toContain('Pending line here.');

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) =>
        e.event === 'detector-trip' &&
        e.site === DERIVE_LOSS_SITE_AGENT_UNDO &&
        Boolean(e.checkpointSha),
    );
    const hist = await getDocumentHistory(shadow, { docName: 'intro' }, '');
    expect(
      hist.entries.some(
        (e) => e.sha === trip.checkpointSha && e.checkpoint?.kind === 'bridge-derive-loss',
      ),
    ).toBe(true);
  });

  it('a suppress-classified paired write (no detect) never trips, even on an intra-line dirty fragment', async () => {
    const { projectRoot, ring } = await setup();
    const doc = seedDivergedDoc(PRE_OP_BODY, PENDING_BODY);
    doc.transact(() => {
      // The rollback/rename shape: a full overwrite with no detect wired.
      replaceRawBody(doc, REPLACEMENT);
    });
    doc.destroy();
    await new Promise((r) => setTimeout(r, 0));
    await ring.drain();
    let events: RingEvent[] = [];
    try {
      events = parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
    } catch {
      // No ring file is also a pass.
    }
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);
  });
});
