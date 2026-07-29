/**
 * Derive-timing defer exhaustion — the loud force-resolve at the drain-count
 * bound, on the REAL `setupServerObservers` drain via the shared bridge-race rig.
 *
 * The defer guard keeps an un-propagated WYSIWYG keystroke alive by deferring
 * the re-derive that would stomp it. Under sustained typing the freshness window
 * never quiets, so Observer A never gets a drain to propagate the keystroke and
 * the defer would repeat forever. This suite pins the bound: after
 * `MAX_DERIVE_TIMING_DEFERS` deferrals the guard stops deferring and
 * force-resolves LOUDLY — it checkpoints the pre-resolve fragment (which still
 * holds the keystroke) and emits a distinguishable ring event carrying that
 * checkpoint's sha, then lets the re-derive proceed. Never a silent clamp: the
 * content leaves the live fragment but stays restorable through the timeline.
 *
 * The re-derive cadence interleaves defers with witness-settling early-exits, so
 * a fixed drain count would be brittle; the suites drive drains until the guard
 * force-resolves, under a ceiling comfortably above the ~15 drains a fresh doc
 * needs — a real regression (force-resolve unreachable) fails fast at the cap.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import type { LossCaptureEventInput } from './loss-capture.ts';
import { getMetrics } from './metrics.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';
const CONTENT_ROOT = 'content/docs';

// Ceiling on drains driven while waiting for the force-resolve. The measured
// worst case on a fresh doc is ~15 drains; this leaves headroom for the
// defer/early-exit cadence to vary while still failing fast if force-resolve
// ever becomes unreachable.
const MAX_DRAINS = 30;

/**
 * Leave the fragment holding the pending `PENDING_LINE` while Y.Text still holds
 * `STALE_LINE`, with the settlement witnesses stale — the un-propagated-keystroke
 * shape whose re-derive the guard defers. Mirrors the H2 stomp suite's staging.
 */
function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

/** A source-editor / non-paired Y.Text write, freshness held hot (sustained typing). */
function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

describe('derive-timing defer exhaustion (H2 exhaustion arm)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('sustained deferral preserves the keystroke until the guard force-resolves loudly', () => {
    const recorded: LossCaptureEventInput[] = [];
    const rig = createBridgeRaceRig({
      docName: 'exhaustion-bound.md',
      setupOverrides: {
        lossRing: {
          record: async (input) => {
            recorded.push(input);
          },
        },
      },
    });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);

      let forced = false;
      for (let i = 0; i < MAX_DRAINS && !forced; i++) {
        // The keystroke survives every drain up to (and including) the one that
        // force-resolves — it is only ever dropped by the loud path, never by a
        // silent defer that lost it.
        expect(rig.serializeFragment()).toContain(PENDING_LINE);
        sourceWrite(rig, `trailing-${i}`);
        forced = getMetrics().deriveTimingDeferForceResolved > before;
      }

      expect(forced).toBe(true);
      // Force-resolve rebuilt the fragment from Y.Text, so the pending content
      // left the live fragment (the checkpoint below keeps it restorable).
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

      // Loud, not a quiet clamp: a distinguishable, content-free ring event fired.
      const evt = recorded.find(
        (e) => e.event === 'checkpoint-write' && e.site === 'derive-timing-exhaustion',
      );
      expect(evt).toBeDefined();
      expect(evt?.direction).toBe('b');
      expect(typeof evt?.lostLen).toBe('number');
      expect(JSON.stringify(evt)).not.toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('a deferring doc reaches the bound through pure drains under a frozen clock', () => {
    const rig = createBridgeRaceRig({ docName: 'exhaustion-quiescent.md' });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);
      // One source write starts the deferring state; after that, no further
      // content — only ambient settlement drains, with the clock never advanced.
      sourceWrite(rig, 'kick');
      expect(rig.serializeFragment()).toContain(PENDING_LINE);

      let forced = false;
      for (let i = 0; i < MAX_DRAINS && !forced; i++) {
        rig.forceARound({ advanceFreshness: false });
        forced = getMetrics().deriveTimingDeferForceResolved > before;
      }

      // The bound was reached by drain count alone — the clock stayed frozen, so
      // a wall-clock bound could never have tripped.
      expect(forced).toBe(true);
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);
    } finally {
      rig.cleanup();
    }
  });

  test('with the guard off nothing defers, so the exhaustion path never fires', () => {
    const rig = createBridgeRaceRig({
      docName: 'exhaustion-guard-off.md',
      setupOverrides: { deferGuardEnabled: false },
    });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);
      // With no defer, the first drain stomps the keystroke outright — there is
      // nothing to accumulate toward the bound.
      for (let i = 0; i < MAX_DRAINS; i++) sourceWrite(rig, `x-${i}`);
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before);
    } finally {
      rig.cleanup();
    }
  });
});

describe('derive-timing defer exhaustion — checkpoint floor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-defer-exhaustion-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupShadow(): Promise<{ shadow: ShadowHandle }> {
    const projectRoot = resolve(tmpDir, 'project');
    const contentDir = resolve(projectRoot, CONTENT_ROOT);
    mkdirSync(contentDir, { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(resolve(contentDir, 'exhaustion.md'), '# Seed\n');
    await git.add('.');
    await git.commit('Initial commit');
    return { shadow: await initShadowRepo(projectRoot) };
  }

  test('force-resolve writes a resolvable defer-exhaustion-loss checkpoint holding the pre-resolve fragment', async () => {
    const { shadow } = await setupShadow();
    const recorded: LossCaptureEventInput[] = [];
    const rig = createBridgeRaceRig({
      docName: 'exhaustion',
      setupOverrides: {
        shadow: () => shadow,
        getBranch: () => 'main',
        contentRoot: CONTENT_ROOT,
        lossRing: {
          record: async (input) => {
            recorded.push(input);
          },
        },
      },
    });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);
      for (let i = 0; i < MAX_DRAINS; i++) {
        sourceWrite(rig, `t-${i}`);
        if (getMetrics().deriveTimingDeferForceResolved > before) break;
      }

      // The checkpoint is written fire-and-forget (queueMicrotask + real git);
      // the ring event fires from inside its `then`, so waiting for the sha-
      // bearing event is waiting for the checkpoint to have landed.
      await vi.waitFor(() =>
        expect(
          recorded.some(
            (e) => e.event === 'checkpoint-write' && typeof e.checkpointSha === 'string',
          ),
        ).toBe(true),
      );

      const evt = recorded.find(
        (e) => e.event === 'checkpoint-write' && e.site === 'derive-timing-exhaustion',
      );
      const sha = evt?.checkpointSha;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // The sha resolves against the checkpoint store as a defer-exhaustion-loss row.
      const hist = await getDocumentHistory(shadow, { docName: 'exhaustion' }, CONTENT_ROOT);
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.type).toBe('checkpoint');
      expect(row?.checkpoint?.kind).toBe('defer-exhaustion-loss');

      // The checkpoint holds the pre-resolve FRAGMENT serialization — the payload
      // that still carries the un-propagated keystroke a Y.Text payload would miss.
      const content = (
        await shadowGit(shadow).raw('show', `${sha}:${CONTENT_ROOT}/exhaustion`)
      ).toString();
      expect(content).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });
});
