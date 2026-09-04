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

const CYCLE_FORM_A = '# Cycle\n\nalpha side of the loop   \n';
const CYCLE_FORM_B = '# Cycle\n\nbravo side of the loop   \n';
function cycleForm(i: number): string {
  return i % 2 === 0 ? CYCLE_FORM_A : CYCLE_FORM_B;
}

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
      driveCycleUntilTrip(rig, trips);

      expect(trips.length).toBe(1);
      const rounds = trips[0] ?? 0;
      expect(rounds).toBeGreaterThanOrEqual(4);
      expect(getMetrics().reDeriveBackstopTripped).toBe(before + 1);

      const evt = recorded.find((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP);
      expect(evt).toBeDefined();
      expect(evt?.direction).toBe('b');
      expect(evt?.site).toBe('rederive-backstop');
      expect(evt?.lostLen).toBeUndefined();
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
      for (let i = 0; i < 20; i++) rig.editFragment(`# Doc\n\nbody line ${i}\n`);
      for (let i = 0; i < 20; i++) rig.seedSource(`# Doc\n\nsource line ${i}\n`);
      for (let i = 0; i < 20; i++) rig.churnedFragmentEdit(`| a | b${i} |\n|---|---|\n| 1 | 2 |\n`);

      expect(trips).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test("the spike's masking-class fixtures each settle to a fixed point without tripping", () => {
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

      rig.seedSource('# Cycle\n\na fresh source edit B will not re-derive while frozen   \n');
      expect(rig.serializeFragment()).toBe(frozenFragment);
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

      rig.seedSource('# Cycle\n\ntyped into source while the loop is frozen — not lost   \n');
      expect(rig.serializeFragment()).toBe(frozenFragment);
      expect(rig.ytext.toString()).toContain(
        'typed into source while the loop is frozen — not lost',
      );

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
      expect(off).toEqual([]);
      expect(rigOff.serializeFragment()).toContain('bravo side of the loop');
    } finally {
      rigOff.cleanup();
    }

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
      let frozenYText = '';
      for (let i = 0; i < 24; i++) {
        rig.seedSource(cycleForm(i));
        if (!frozenYText && trips.length > 0) {
          frozenYText = rig.ytext.toString();
          break;
        }
      }
      expect(frozenYText).not.toBe('');

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

      const hist = await getDocumentHistory(shadow, { docName: 'backstop' }, CONTENT_ROOT);
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.type).toBe('checkpoint');
      expect(row?.checkpoint?.kind).toBe('bridge-backstop-trip');

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
      expect(getMetrics().reDeriveBackstopTripped).toBe(before + 1);

      await vi.waitFor(() =>
        expect(recorded.some((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP)).toBe(true),
      );
      const evt = recorded.find((e) => e.event === LOSS_EVENT_BACKSTOP_TRIP);
      expect(evt?.direction).toBe('b');
      expect(evt?.site).toBe('rederive-backstop');
      expect(evt?.checkpointSha).toBeUndefined();
    } finally {
      rig.cleanup();
    }
  });
});
