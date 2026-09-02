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
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for loss-ring event');
}

function buildFragment(doc: Y.Doc, body: string): void {
  const xf = doc.getXmlFragment('default');
  const pm = schema.nodeFromJSON(mdManager.parseWithFallback(body, undefined));
  doc.transact(() => updateYFragment(doc, xf, pm, { mapping: new Map(), isOMark: new Map() }));
}

function seedDivergedDoc(syncedMd: string, pendingBody: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('source').insert(0, syncedMd);
  buildFragment(doc, stripFrontmatter(syncedMd).body);
  buildFragment(doc, pendingBody);
  return doc;
}

describe('detectDeriveLoss (the twin verdict)', () => {
  it('flags a never-propagated fragment line that both twins lack', () => {
    const obs: DeriveLossObservation = {
      pendingBody: 'Shared body\n\nPending keystroke',
      baselineBody: 'Shared body',
      ytextDerivedBody: 'Shared body',
      rebuiltBody: 'Shared body',
      restorePayload: 'Shared body\n\nPending keystroke',
    };
    expect(detectDeriveLoss(obs)).toEqual(['Pending keystroke']);
  });

  it('does NOT flag content the operation legitimately removed (an intended undo)', () => {
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

    const trip = await pollForEvent(
      projectRoot,
      ring,
      (e) => e.event === 'detector-trip' && Boolean(e.checkpointSha),
    );
    expect(trip).toBeDefined();
    expect(trip?.direction).toBe('b');
    expect(trip?.docName).toBe('intro');
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
    } catch {}
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
    const canonical = 'A paragraph\n\nAnother paragraph';
    const raw = 'A paragraph\n\n\n\nAnother paragraph';
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
    } catch {}
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
    } catch {}
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);
  }

  it('file-watcher intake: a disk write that drops un-propagated fragment content trips + checkpoints', async () => {
    const { projectRoot, shadow, ring, reporter } = await setupReporter();
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
    const { projectRoot, ring } = await setupReporter();
    const doc = seedDivergedDoc('# Title\n\nOriginal', '# Title\n\nOriginal\n\nPending keystroke');
    doc.transact(() => {
      replaceRawBody(doc, '# Title\n\nRolled back to an older version');
    });
    doc.destroy();
    await assertNoTrip(projectRoot, ring);
  });
});

describe('detectPairedIntakeLoss (the line-predicate floor)', () => {
  const INTRA_LINE_STOMP: DeriveLossObservation = {
    pendingBody: 'Deploy the staging server now.',
    baselineBody: 'Deploy the server now.',
    ytextDerivedBody: 'Restart the staging cluster later.',
    rebuiltBody: 'Restart the staging cluster later.',
    restorePayload: 'Deploy the staging server now.',
  };

  it('flags an intra-line stomp the substring twin filters away', () => {
    expect(detectDeriveLoss(INTRA_LINE_STOMP)).toEqual([]);
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

    expect(blob).toBe(obs.restorePayload);
    expect(blob).toContain(PENDING_LINE);
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
      replaceRawBody(doc, REPLACEMENT);
    });
    doc.destroy();
    await new Promise((r) => setTimeout(r, 0));
    await ring.drain();
    let events: RingEvent[] = [];
    try {
      events = parseLossCaptureLines(readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'));
    } catch {}
    expect(events.filter((e) => e.event === 'detector-trip')).toEqual([]);
  });
});
