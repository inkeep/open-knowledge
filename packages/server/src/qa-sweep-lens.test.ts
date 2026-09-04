import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { getMetrics } from './metrics.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';
import { getDocumentHistory } from './timeline-query.ts';

function count(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';
const CONTENT_ROOT = 'content/docs';

function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, { advanceFreshness: false });
}
function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

describe('QA-007: abrupt-insertion sweep — no content exists that no one authored', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  test('after a completed force-resolve mechanism run, every line in final Y.Text is present in the authored ledger; zero unauthored spans', () => {
    const rig = createBridgeRaceRig({ docName: 'qa007-sweep.md' });
    const before = getMetrics().deriveTimingDeferForceResolved;
    const authored: string[] = [GEN1, '\nTrailing.\n', PENDING_LINE, STALE_LINE];
    try {
      stageUnpropagatedKeystroke(rig);
      for (let i = 0; i < 30; i++) {
        const t = `trailing-${i}`;
        authored.push(`\n${t}\n`);
        sourceWrite(rig, t);
        if (getMetrics().deriveTimingDeferForceResolved > before) break;
      }
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

      const union = authored.join('\n');
      const finalYtext = rig.ytext.toString();
      const finalFragMd = rig.serializeFragment();

      const unauthored: string[] = [];
      let linesScanned = 0;
      for (const raw of [...finalYtext.split('\n'), ...finalFragMd.split('\n')]) {
        const line = raw.trim();
        if (line === '') continue;
        linesScanned++;
        if (!union.includes(line)) unauthored.push(line);
      }
      expect(finalYtext.trim().length).toBeGreaterThan(0);
      expect(finalFragMd.trim().length).toBeGreaterThan(0);
      expect(linesScanned).toBeGreaterThanOrEqual(2 * authored.length);

      expect(unauthored).toEqual([]);
      expect(count(finalYtext, 'Intro paragraph.')).toBe(1);
      expect(count(finalYtext, 'Trailing.')).toBe(1);
      expect(count(finalFragMd, 'Intro paragraph.')).toBe(1);
      console.log(`[QA-007] final lines all authored; unauthored spans=${unauthored.length}`);
    } finally {
      rig.cleanup();
    }
  });
});

describe('QA-008: x211 churned composition — all mechanisms ON simultaneously', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  test('churned-fragment interleavings converge to a byte fixed point with occurrence counts === authored and NO backstop false-trip (defaults: defer+detector+backstop+pre-drain all ON)', () => {
    let backstopTrips = 0;
    const rig = createBridgeRaceRig({
      docName: 'qa008-composition.md',
      setupOverrides: { onReDeriveBackstop: () => backstopTrips++ },
    });
    const backstopBefore = getMetrics().reDeriveBackstopTripped;
    try {
      for (let i = 0; i < 20; i++) {
        rig.churnedFragmentEdit(`| a | b${i} |\n|---|---|\n| 1 | 2 |\n`);
      }
      const settled = rig.settle(4);
      const lastByteChanged = settled.slice(-2).some((e) => e.byteChanged);

      expect(lastByteChanged).toBe(false);
      expect(backstopTrips).toBe(0);
      expect(getMetrics().reDeriveBackstopTripped).toBe(backstopBefore);

      const yt = rig.ytext.toString();
      expect(count(yt, '| a | b19 |')).toBe(1);
      expect(count(yt, '| 1 | 2 |')).toBe(1);
      const frag = rig.serializeFragment();
      expect(count(frag, 'b19')).toBe(1);
      console.log(
        `[QA-008] churned composition converged; backstopTrips=${backstopTrips}; b19 count=${count(yt, '| a | b19 |')}`,
      );
    } finally {
      rig.cleanup();
    }
  });
});

describe('QA-009: restore is NEVER automatic — checkpoint content stays out of the live doc', () => {
  let tmpDir: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-qa009-'));
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
    writeFileSync(resolve(contentDir, 'qa009.md'), '# Seed\n');
    await git.add('.');
    await git.commit('Initial commit');
    return initShadowRepo(projectRoot);
  }

  test('a force-resolve checkpoint is restore-reachable via history, but its content is NEVER auto-re-inserted into the live Y.Text/fragment (no user rollback)', async () => {
    const shadow = await setupShadow();
    const rig = createBridgeRaceRig({
      docName: 'qa009',
      setupOverrides: {
        shadow: () => shadow,
        getBranch: () => 'main',
        contentRoot: CONTENT_ROOT,
      },
    });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);
      for (let i = 0; i < 30; i++) {
        sourceWrite(rig, `t-${i}`);
        if (getMetrics().deriveTimingDeferForceResolved > before) break;
      }
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

      expect(count(rig.serializeFragment(), PENDING_LINE)).toBe(0);
      expect(count(rig.ytext.toString(), PENDING_LINE)).toBe(0);

      await vi.waitFor(async () => {
        const hist = await getDocumentHistory(shadow, { docName: 'qa009' }, CONTENT_ROOT);
        const cp = hist.entries.find((e) => e.checkpoint?.kind === 'defer-exhaustion-loss');
        expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/);
        const blob = (
          await shadowGit(shadow).raw('show', `${cp?.sha}:${CONTENT_ROOT}/qa009`)
        ).toString();
        expect(blob).toContain(PENDING_LINE);
      });

      rig.settle(6);
      expect(count(rig.serializeFragment(), PENDING_LINE)).toBe(0);
      expect(count(rig.ytext.toString(), PENDING_LINE)).toBe(0);
      console.log('[QA-009] checkpoint restore-reachable; live doc never auto-gains it');
    } finally {
      rig.cleanup();
    }
  });
});
