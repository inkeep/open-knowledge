/**
 * Re-derive-loop fixed-point backstop (the loud re-derive-loop tripwire) on the REAL
 * `setupServerObservers` drain via the shared bridge-race rig.
 *
 * The Y.Text→XmlFragment re-derive cycle terminates on a RAW-BYTE fixed point: a
 * drain whose settled Y.Text raw-equals the fragment's canonical serialization.
 * A run of re-derive drains that never reaches one hits a drain-count backstop
 * that freezes the B-direction re-derive loop LOUDLY — a checkpoint of the
 * authoritative Y.Text plus a distinguishable `backstop-trip` ring event, never
 * a silent truncate-and-continue. The A-direction (user edits) and persistence
 * stay live.
 *
 * Distinguishing a loop from progress. A doc that never reaches a raw fixed
 * point but keeps advancing to NEW states is forward progress (a large
 * residual-bearing edit stream), not a loop. A doc that never converges and
 * REVISITS a recently-settled state is oscillating. The backstop counts
 * consecutive corrective drains whose settled Y.Text revisits the recent ring;
 * a run reaching the bound freezes the B-direction loop.
 *
 * The revisit signal is raw bytes, not `normalizeBridge` tolerance: two forms
 * that are normalize-EQUAL but byte-different (a trailing-whitespace residual
 * serialize never reproduces) are distinct states, so an oscillation between
 * them still trips — which a normalize-tolerant check would mask. Single-server
 * flows self-correct to a fixed point,
 * so a sustained oscillation is the un-probed echo/normalize-UNEQUAL residue
 * this cap exists to bound; the synthetic corrective-write loop below drives it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { LOSS_EVENT_BACKSTOP_TRIP, type LossCaptureEventInput } from './loss-capture.ts';
import { getMetrics } from './metrics.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

const CONTENT_ROOT = 'content/docs';

// Two non-round-trip source forms that are normalize-EQUAL to their canonical
// (the trailing whitespace is tolerated but stripped by serialize, so neither
// reaches a raw-byte fixed point) yet byte-different from each other. Alternating
// them is a 2-cycle: the doc revisits a recent state every round without ever
// converging — the synthetic corrective-write loop.
const CYCLE_FORM_A = '# Cycle\n\nalpha side of the loop   \n';
const CYCLE_FORM_B = '# Cycle\n\nbravo side of the loop   \n';
function cycleForm(i: number): string {
  return i % 2 === 0 ? CYCLE_FORM_A : CYCLE_FORM_B;
}

/** Drive the oscillation until the backstop trips (or a generous ceiling). */
function driveCycleUntilTrip(rig: ReturnType<typeof createBridgeRaceRig>, trips: number[]): void {
  for (let i = 0; i < 24 && trips.length === 0; i++) rig.seedSource(cycleForm(i));
}

describe('re-derive fixed-point backstop (H4)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a normalize-equal-but-byte-different loop is not treated as converged and trips the backstop loudly', () => {
    const trips: number[] = [];
    const recorded: LossCaptureEventInput[] = [];
    const rig = createBridgeRaceRig({
      docName: 'backstop-trip.md',
      setupOverrides: {
        onReDeriveBackstop: (rounds) => trips.push(rounds),
        lossRing: {
          record: async (input) => {
            recorded.push(input);
          },
        },
      },
    });
    const before = getMetrics().reDeriveBackstopTripped;
    try {
      // The doc revisits two byte-different, normalize-equal states every round
      // and never converges. A normalize-tolerant termination check would call
      // both states converged and never trip.
      driveCycleUntilTrip(rig, trips);

      // Loud trip: exactly one, with the drain-count bound reported.
      expect(trips.length).toBe(1);
      const rounds = trips[0] ?? 0;
      // Cap is at least 4 (2x the worst measured legitimate run of 1).
      expect(rounds).toBeGreaterThanOrEqual(4);
      expect(getMetrics().reDeriveBackstopTripped).toBe(before + 1);

      // A distinguishable, content-free backstop-trip ring event fired.
      const evt = recorded.find((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP);
      expect(evt).toBeDefined();
      expect(evt?.direction).toBe('b');
      expect(evt?.site).toBe('rederive-backstop');
      // No `lostLen`: the freeze loses nothing — Y.Text stays authoritative and
      // the checkpoint anchors it. Only the B-direction re-derive stops.
      expect(evt?.lostLen).toBeUndefined();
      // Content-free: the document text never rides the event.
      expect(JSON.stringify(evt)).not.toContain('side of the loop');
    } finally {
      rig.cleanup();
    }
  });

  test('a churned-table respell oscillation trips: alternating pipe-dash table forms revisit without converging', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'table-cycle.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      // Two table forms (canonical pipe-dash delimiter, so no watchdog trip) that
      // carry a trailing-whitespace residual serialize strips — non-round-trip and
      // byte-different from each other. Alternating them revisits a recent state
      // every round without converging: the churned-table respell as a sustained
      // corrective-write loop.
      const tableA = '| a | alpha |\n| - | - |\n| 1 | 2 |   \n';
      const tableB = '| a | bravo |\n| - | - |\n| 1 | 2 |   \n';
      for (let i = 0; i < 24 && trips.length === 0; i++) {
        rig.seedSource(i % 2 === 0 ? tableA : tableB);
      }
      expect(trips.length).toBe(1);
    } finally {
      rig.cleanup();
    }
  });

  test('forward progress never trips: a monotonic non-round-trip edit stream advances without oscillating', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'progress.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      // Each round is a NEW state carrying a trailing-whitespace residual (never a
      // raw-byte fixed point), but the content keeps advancing — forward progress,
      // not a revisit. The backstop must not freeze a doc that is simply large or
      // residual-bearing.
      for (let i = 0; i < 40; i++) rig.seedSource(`# Doc\n\nrunning body line ${i}   \n`);
      expect(trips).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('legitimate flows never trip: WYSIWYG typing, round-trip source typing, and a churned-table respell all settle', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'legit.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      // WYSIWYG typing: each keystroke is new content that converges (A writes
      // the canonical serialization, so Y.Text raw-equals the fragment).
      for (let i = 0; i < 20; i++) rig.editFragment(`# Doc\n\nbody line ${i}\n`);
      // Round-trip-stable source typing: parse captures the bytes, so each
      // re-derive reaches a raw fixed point.
      for (let i = 0; i < 20; i++) rig.seedSource(`# Doc\n\nsource line ${i}\n`);
      // A churned-table respell (pipe-dash canonicalization) is k=1 stable — it
      // canonicalizes in one round and settles, never a sustained loop.
      for (let i = 0; i < 20; i++) rig.churnedFragmentEdit(`| a | b${i} |\n|---|---|\n| 1 | 2 |\n`);

      expect(trips).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test("the spike's masking-class fixtures each settle to a fixed point without tripping", () => {
    // The tolerance classes canonicalize on the first materializing write and
    // then rest (k<=1 per the oscillation spike). Repeatedly re-churning each one
    // stays at that fixed point — a settled residual, never a revisiting loop.
    const maskingFixtures = [
      '# Escape\n\n_leading underscore word\n\n[bracket opener text\n',
      'Wrap **before ** mid ** after** end.\n',
      '- top\n    - nested four\n        - deeper eight\n',
      '# Title   \n\nParagraph one ends here.   \n\nLast.\n',
      '1. one\n1. two\n1. three\n',
    ];
    for (const fixture of maskingFixtures) {
      const trips: number[] = [];
      const rig = createBridgeRaceRig({
        docName: 'masking.md',
        setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
      });
      try {
        // Re-churn the same fixture repeatedly (models a client dropping the
        // source-capture attrs): the canonicalization is a one-way ratchet, so it
        // settles after the first round and never accumulates.
        for (let i = 0; i < 20; i++) rig.churnedFragmentEdit(fixture);
        rig.settle(4);
        expect(trips).toEqual([]);
      } finally {
        rig.cleanup();
      }
    }
  });

  test('forced settlement rounds on a converged doc are fixed points, not events', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'rest.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      rig.seedSource('# Rest\n\nsettled body.\n');
      // Byte-neutral forced Observer-A rounds: A runs every gate and emits zero
      // new bytes — a zero-byte round IS the fixed point, even when a re-derive
      // fires. No round accumulates.
      rig.settle(20);
      expect(trips).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('D2-deferred drains are non-events for the backstop', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'defer-noevent.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    const beforeForceResolve = getMetrics().deriveTimingDeferForceResolved;
    try {
      // Stage an un-propagated keystroke, then sustain the freshness-hot window so
      // the defer guard defers up to its own bound and force-resolves. Those
      // deferred drains must not feed the backstop counter: the defer path drives
      // to its force-resolve without the backstop tripping first.
      rig.editFragment(
        '## Guide\n\nIntro.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n',
      );
      rig.settle(1);
      rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
      rig.echoFragmentEdit(rig.ytext.toString(), 'Step one bod', 'Step one body.', {
        advanceFreshness: false,
      });
      for (let i = 0; i < 30; i++) {
        rig.externalYtextEdit('src', (yt) => yt.insert(yt.length, `\nt-${i}\n`), {
          advanceFreshness: false,
        });
        if (getMetrics().deriveTimingDeferForceResolved > beforeForceResolve) break;
      }
      // The defer path fired its own loud force-resolve; the backstop stayed
      // silent — deferred drains never counted toward its bound.
      expect(getMetrics().deriveTimingDeferForceResolved).toBeGreaterThan(beforeForceResolve);
      expect(trips).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('freeze scope: the B-direction is frozen while persistence stays live', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'freeze-b.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      driveCycleUntilTrip(rig, trips);
      expect(trips.length).toBe(1);
      const frozenFragment = rig.serializeFragment();

      // B is frozen: a further source edit does NOT rebuild the fragment (it
      // stays at the pre-freeze content) — the B-direction re-derive is skipped.
      rig.seedSource('# Cycle\n\na fresh source edit B will not re-derive while frozen   \n');
      expect(rig.serializeFragment()).toBe(frozenFragment);
      // Persistence stays live: Y.Text (the source of truth) still holds the edit.
      expect(rig.ytext.toString()).toContain('a fresh source edit B will not re-derive');
    } finally {
      rig.cleanup();
    }
  });

  test('freeze scope: the A-direction stays live and a converging drain unfreezes the loop', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'freeze-a.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      driveCycleUntilTrip(rig, trips);
      expect(trips.length).toBe(1);

      // The A-direction stays live: a WYSIWYG fragment edit right after the trip
      // (Y.Text still matches the last settlement witness, so Observer A takes the
      // clean Path-A write) propagates to a raw-equal Y.Text, which unfreezes the
      // loop. A subsequent source edit then re-derives normally again.
      rig.editFragment('# Recovered\n\nwysiwyg edit converges the doc\n');
      expect(rig.ytext.toString()).toContain('wysiwyg edit converges the doc');
      rig.seedSource('# After\n\nsource edit re-derives after the unfreeze\n');
      expect(rig.serializeFragment()).toContain('source edit re-derives after the unfreeze');
    } finally {
      rig.cleanup();
    }
  });

  test('typing during a freeze persists — the user-edit path and Y.Text stay live while the B loop is frozen', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'freeze-persists.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      driveCycleUntilTrip(rig, trips);
      expect(trips.length).toBe(1);
      const frozenFragment = rig.serializeFragment();

      // Persistence stays live through the freeze: a source keystroke (direct
      // Y.Text) lands in the authoritative bytes and is not lost, while the B
      // re-derive loop stays frozen (the fragment does not rebuild). Freeze
      // scope is B-only; Y.Text-is-truth persistence is never part of it.
      rig.seedSource('# Cycle\n\ntyped into source while the loop is frozen — not lost   \n');
      expect(rig.serializeFragment()).toBe(frozenFragment);
      expect(rig.ytext.toString()).toContain(
        'typed into source while the loop is frozen — not lost',
      );

      // The A-direction stays live too: a WYSIWYG edit propagates through
      // Observer A into Y.Text. Observer A runs before (and independently of) the
      // frozen B re-derive, so user typing keeps reaching the source of truth.
      rig.editFragment('# Typed\n\nwysiwyg content typed during the freeze reaches Y.Text\n');
      expect(rig.ytext.toString()).toContain(
        'wysiwyg content typed during the freeze reaches Y.Text',
      );
    } finally {
      rig.cleanup();
    }
  });

  test('kill-switch OFF: the loop churns unbounded with no trip; default-ON pinned', () => {
    const off: number[] = [];
    const rigOff = createBridgeRaceRig({
      docName: 'backstop-off.md',
      setupOverrides: { fixedPointBackstopEnabled: false, onReDeriveBackstop: (r) => off.push(r) },
    });
    try {
      for (let i = 0; i < 24; i++) rigOff.seedSource(cycleForm(i));
      // Inert: the same oscillation that trips when ON churns unbounded.
      expect(off).toEqual([]);
      // B is never frozen — the last source edit still re-derives.
      expect(rigOff.serializeFragment()).toContain('bravo side of the loop');
    } finally {
      rigOff.cleanup();
    }

    // Default-ON: an unconfigured rig (no fixedPointBackstopEnabled) trips.
    const on: number[] = [];
    const rigOn = createBridgeRaceRig({
      docName: 'backstop-default.md',
      setupOverrides: { onReDeriveBackstop: (r) => on.push(r) },
    });
    try {
      driveCycleUntilTrip(rigOn, on);
      expect(on.length).toBe(1);
    } finally {
      rigOn.cleanup();
    }
  });
});

describe('re-derive fixed-point backstop — checkpoint floor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-backstop-'));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupShadow(): Promise<ShadowHandle> {
    const projectRoot = resolve(tmpDir, 'project');
    const contentDir = resolve(projectRoot, CONTENT_ROOT);
    mkdirSync(contentDir, { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    writeFileSync(resolve(contentDir, 'backstop.md'), '# Seed\n');
    await git.add('.');
    await git.commit('Initial commit');
    return initShadowRepo(projectRoot);
  }

  test('a trip writes a resolvable bridge-backstop-trip checkpoint holding the frozen Y.Text', async () => {
    const shadow = await setupShadow();
    const recorded: LossCaptureEventInput[] = [];
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'backstop',
      setupOverrides: {
        onReDeriveBackstop: (r) => trips.push(r),
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
    try {
      // Capture the authoritative Y.Text at the exact drain that trips — later
      // source edits still land in Y.Text (persistence stays live), so the
      // post-loop bytes differ from what the checkpoint anchored at freeze time.
      let frozenYText = '';
      for (let i = 0; i < 24; i++) {
        rig.seedSource(cycleForm(i));
        if (!frozenYText && trips.length > 0) {
          frozenYText = rig.ytext.toString();
          break;
        }
      }
      expect(frozenYText).not.toBe('');

      // The checkpoint is fire-and-forget (queueMicrotask + real git); the
      // sha-bearing ring event fires from inside its `then`.
      await vi.waitFor(() =>
        expect(
          recorded.some(
            (e) => e.event === LOSS_EVENT_BACKSTOP_TRIP && typeof e.checkpointSha === 'string',
          ),
        ).toBe(true),
      );
      const evt = recorded.find(
        (e) => e.event === LOSS_EVENT_BACKSTOP_TRIP && typeof e.checkpointSha === 'string',
      );
      const sha = evt?.checkpointSha;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      // The sha resolves against the checkpoint store as a bridge-backstop-trip row.
      const hist = await getDocumentHistory(shadow, { docName: 'backstop' }, CONTENT_ROOT);
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.type).toBe('checkpoint');
      expect(row?.checkpoint?.kind).toBe('bridge-backstop-trip');

      // The checkpoint holds the authoritative Y.Text at freeze time — the
      // restore anchor for the pre-freeze state.
      const content = (
        await shadowGit(shadow).raw('show', `${sha}:${CONTENT_ROOT}/backstop`)
      ).toString();
      expect(content).toBe(frozenYText);
    } finally {
      rig.cleanup();
    }
  });

  test('a checkpoint-write failure still fires a sha-less backstop-trip ring event (never silent)', async () => {
    const recorded: LossCaptureEventInput[] = [];
    const trips: number[] = [];
    // A shadow handle pointing at a non-existent git dir makes the REAL
    // saveInMemoryCheckpoint write reject — the compound shadow-write-failure
    // path (disk full, permissions, collision) the no-shadow branch can't reach.
    const brokenShadow: ShadowHandle = {
      gitDir: resolve(tmpDir, 'no-such-shadow.git'),
      workTree: resolve(tmpDir, 'no-such-worktree'),
    };
    const rig = createBridgeRaceRig({
      docName: 'backstop',
      setupOverrides: {
        onReDeriveBackstop: (r) => trips.push(r),
        shadow: () => brokenShadow,
        getBranch: () => 'main',
        contentRoot: CONTENT_ROOT,
        lossRing: {
          record: async (input) => {
            recorded.push(input);
          },
        },
      },
    });
    const before = getMetrics().reDeriveBackstopTripped;
    try {
      driveCycleUntilTrip(rig, trips);
      expect(trips.length).toBe(1);
      // The trip is real: the counter moved even though the checkpoint write is
      // about to fail — the "metric up" half the ring must corroborate.
      expect(getMetrics().reDeriveBackstopTripped).toBe(before + 1);

      // The checkpoint write rejects (bogus git dir), so the catch runs. It must
      // still emit a sha-less backstop-trip ring event — otherwise the fire is
      // invisible in loss-current.jsonl and the freeze reads like "ring disabled".
      await vi.waitFor(() =>
        expect(recorded.some((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP)).toBe(true),
      );
      const evt = recorded.find((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP);
      expect(evt?.direction).toBe('b');
      expect(evt?.site).toBe('rederive-backstop');
      // Sha-less: the checkpoint never landed, so there is no restore anchor.
      expect(evt?.checkpointSha).toBeUndefined();
    } finally {
      rig.cleanup();
    }
  });
});
