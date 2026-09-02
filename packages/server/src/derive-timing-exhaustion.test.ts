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

const MAX_DRAINS = 30;

function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

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
        expect(rig.serializeFragment()).toContain(PENDING_LINE);
        sourceWrite(rig, `trailing-${i}`);
        forced = getMetrics().deriveTimingDeferForceResolved > before;
      }

      expect(forced).toBe(true);
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

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
      sourceWrite(rig, 'kick');
      expect(rig.serializeFragment()).toContain(PENDING_LINE);

      let forced = false;
      for (let i = 0; i < MAX_DRAINS && !forced; i++) {
        rig.forceARound({ advanceFreshness: false });
        forced = getMetrics().deriveTimingDeferForceResolved > before;
      }

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

      const hist = await getDocumentHistory(shadow, { docName: 'exhaustion' }, CONTENT_ROOT);
      const row = hist.entries.find((e) => e.sha === sha);
      expect(row?.type).toBe('checkpoint');
      expect(row?.checkpoint?.kind).toBe('defer-exhaustion-loss');

      const content = (
        await shadowGit(shadow).raw('show', `${sha}:${CONTENT_ROOT}/exhaustion`)
      ).toString();
      expect(content).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });
});
