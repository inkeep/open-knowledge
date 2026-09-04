import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import { LossCaptureRing, lossCaptureCurrentPath, parseLossCaptureLines } from './loss-capture.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  WIRED_STALE_LINE,
} from './pre-drain-wired.test-helper.ts';
import { getPreDrainController } from './server-observers.ts';
import { initShadowRepo, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

describe('pre-drain paired-vector arms (H15)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('CROSS-BLOCK undo: the pending keystroke survives in Y.Text and the re-derived fragment', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'cross-undo.md' });
    try {
      rig.agentWrite('Agent appended line.', 'append');
      expect(rig.ytextString()).toContain('Agent appended line.');

      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

      const undone = rig.agentUndo('last');

      expect(undone).toBe(true);
      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).not.toContain('Agent appended line.');
      expect(rig.serializeFragment()).not.toContain('Agent appended line.');
    } finally {
      await rig.cleanup();
    }
  });

  test('CROSS-BLOCK agent append: the pending keystroke survives and the append lands', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'cross-append.md' });
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');

      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).toContain('A fresh agent paragraph.');
    } finally {
      await rig.cleanup();
    }
  });

  test('kill-switch OFF: the cross-block keystroke is NOT flushed (left for the floor)', async () => {
    const rig = await createWiredPreDrainRig({
      docName: 'kill-off.md',
      setupOverrides: { preDrainEnabled: false },
    });
    try {
      rig.agentWrite('Agent appended line.', 'append');
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);

      rig.agentUndo('last');

      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
    } finally {
      await rig.cleanup();
    }
  });

  test('dirty-flag gating: a clean paired op short-circuits without a discriminator pass', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'clean-op.md' });
    try {
      const controller = getPreDrainController(rig.doc);
      expect(controller).toBeDefined();
      const verdict = controller?.preDrain({
        kind: 'agent-write',
        composedBody: 'anything',
        writeKind: 'append',
      });
      expect(verdict?.reason).toBe('skip-no-pending');
      expect(verdict?.preDrain).toBe(false);
    } finally {
      await rig.cleanup();
    }
  });

  test('INERT on replace-intent: a whole-doc replace op declines and never flushes', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'replace-inert.md' });
    try {
      rig.stageUnpropagatedKeystroke();
      const before = rig.ytextString();
      expect(before).toContain(WIRED_STALE_LINE);
      expect(before).not.toContain(WIRED_PENDING_LINE);

      const verdict = getPreDrainController(rig.doc)?.preDrain({
        kind: 'agent-write',
        composedBody: '## Replaced\n\nBrand new body.\n',
        writeKind: 'replace',
      });

      expect(verdict?.preDrain).toBe(false);
      expect(rig.ytextString()).toBe(before);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);
    } finally {
      await rig.cleanup();
    }
  });

  test('NO-TARGET: an undo with an empty stack neither flushes nor throws', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'no-target.md' });
    try {
      rig.stageUnpropagatedKeystroke();
      const before = rig.ytextString();

      const undone = rig.agentUndo('last');

      expect(undone).toBe(false);
      expect(rig.ytextString()).toBe(before);
    } finally {
      await rig.cleanup();
    }
  });

  test('SAME-BLOCK / overlap: a replace over the pending content checkpoints it byte-level, restorable', async () => {
    const tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-pre-drain-floor-'));
    const projectRoot = resolve(tmpDir, 'project');
    const shadow = await initShadowRepo(projectRoot);
    const ring = new LossCaptureRing({ projectDir: projectRoot, maxBytes: 1_000_000 });
    const reporter = createBridgeDeriveLossReporter({
      shadow: () => shadow,
      ring,
      getBranch: () => 'main',
      contentRoot: '',
    });
    const rig = await createWiredPreDrainRig({ docName: 'overlap', reporter });
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('## Replaced\n\nBrand new body.\n', 'replace');

      let trip: ReturnType<typeof parseLossCaptureLines>[number] | undefined;
      for (let i = 0; i < 100 && !trip; i++) {
        await ring.drain();
        try {
          const events = parseLossCaptureLines(
            readFileSync(lossCaptureCurrentPath(projectRoot), 'utf-8'),
          );
          trip = events.find((e) => e.event === 'detector-trip' && Boolean(e.checkpointSha));
        } catch {}
        if (!trip) await new Promise((r) => setTimeout(r, 10));
      }
      expect(trip).toBeDefined();
      expect(typeof trip?.lostLen).toBe('number');
      expect(JSON.stringify(trip)).not.toContain(WIRED_PENDING_LINE);

      const blob = (
        await shadowGit(shadow).raw('show', `${trip?.checkpointSha}:overlap`)
      ).toString();
      expect(blob).toContain(WIRED_PENDING_LINE);

      const hist = await getDocumentHistory(shadow, { docName: 'overlap' }, '');
      const row = hist.entries.find((e) => e.sha === trip?.checkpointSha);
      expect(row?.checkpoint?.kind).toBe('bridge-derive-loss');
    } finally {
      await rig.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('pre-drain frontmatter-ambiguity decline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a pending doc-start rule pair declines the flush instead of writing un-adjusted bytes', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'fm-ambiguous-predrain.md' });
    try {
      rig.rig.seedSource('seed body\n');
      rig.rig.externalYtextEdit('poke', (yt) => {
        yt.insert(yt.length, 'trailing\n');
      });
      rig.rig.editFragment('---\n\nx\n\n---\n\nseed body\n', { advanceFreshness: false });

      const pending = rig.serializeFragment();
      expect(pending.startsWith('---')).toBe(true);
      expect(rig.ytextString().startsWith('---')).toBe(false);

      const verdict = getPreDrainController(rig.doc)?.preDrain({
        kind: 'agent-write',
        composedBody: 'anything',
        writeKind: 'append',
      });
      expect(verdict?.preDrain).toBe(false);
      expect(verdict?.reason).toBe('checkpoint-fm-ambiguous');

      expect(rig.ytextString().startsWith('---')).toBe(false);
    } finally {
      await rig.cleanup();
    }
  });
});
