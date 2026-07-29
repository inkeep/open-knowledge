/**
 * Whole-document sweeps that the per-mechanism suites cannot express.
 *
 * Three questions, each answered against the final settled state rather than a
 * single assertion inside one mechanism\'s arm: does the document contain any
 * span neither the user nor the agent authored (the merge-resurrection class);
 * do the churned interleavings converge to a byte fixed point with every
 * mechanism enabled at once; and is checkpointed content ever re-inserted into
 * the live document without an explicit restore.
 */
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
    // Authored-input ledger: every byte a user/agent/seed actually wrote.
    const authored: string[] = [GEN1, '\nTrailing.\n', PENDING_LINE, STALE_LINE];
    try {
      stageUnpropagatedKeystroke(rig);
      for (let i = 0; i < 30; i++) {
        const t = `trailing-${i}`;
        authored.push(`\n${t}\n`);
        sourceWrite(rig, t);
        if (getMetrics().deriveTimingDeferForceResolved > before) break;
      }
      // PRECONDITION — the mechanism this test is titled for actually ran. The
      // loop exits by `break`, so without this the suite would pass having
      // exhausted every iteration with the force-resolve never firing; the
      // checkpoint-restore sweep below asserts the same counter for the same
      // reason.
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

      // Normalized authored union (documented canonicalization tolerance: the
      // bridge collapses blank-line runs, e.g. '## H\nP' -> '## H\n\nP'; compare
      // per-line trimmed against the concatenated union rather than blanket-fuzzy).
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
      // NON-VACUITY — `unauthored` collects only non-blank lines, so a wiped
      // document yields [] and satisfies the sweep. Total content loss is not a
      // pass: the scan must have had real lines to judge, on BOTH surfaces.
      expect(finalYtext.trim().length).toBeGreaterThan(0);
      expect(finalFragMd.trim().length).toBeGreaterThan(0);
      expect(linesScanned).toBeGreaterThanOrEqual(2 * authored.length);

      expect(unauthored).toEqual([]); // Path-B resurrection class = a line in NEITHER set
      // Occurrence-count oracle, both bounds. `toBeLessThanOrEqual(1)` is
      // satisfied by 0 — i.e. by the content having been deleted outright — so
      // the surviving-exactly-once form is the one that discriminates a
      // duplication from a loss.
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
      // NO overrides that disable mechanisms -> all default-ON (deferGuard,
      // lossDetector, fixedPointBackstop, preDrain).
      setupOverrides: { onReDeriveBackstop: () => backstopTrips++ },
    });
    const backstopBefore = getMetrics().reDeriveBackstopTripped;
    try {
      // A churned table respell that is k=1 stable (canonical pipe-dash) — a
      // LEGITIMATE duplication-recovery shape, not an oscillation. Drive many
      // churned interleavings; the stack must converge.
      for (let i = 0; i < 20; i++) {
        rig.churnedFragmentEdit(`| a | b${i} |\n|---|---|\n| 1 | 2 |\n`);
      }
      // Settle to a byte fixed point.
      const settled = rig.settle(4);
      const lastByteChanged = settled.slice(-2).some((e) => e.byteChanged);

      // Byte fixed point reached: the final forced rounds emit no byte change.
      expect(lastByteChanged).toBe(false);
      // Legitimate churn/recovery must NOT be frozen by the backstop.
      expect(backstopTrips).toBe(0);
      expect(getMetrics().reDeriveBackstopTripped).toBe(backstopBefore);

      // Occurrence counts === authored: exactly one table row `b19` survives,
      // no doubled table subtree.
      const yt = rig.ytext.toString();
      expect(count(yt, '| a | b19 |')).toBe(1);
      expect(count(yt, '| 1 | 2 |')).toBe(1);
      // Bridge coherence: re-derived fragment agrees (a doubled fragment would
      // re-trip on the next drain).
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

      // The checkpointed content left the LIVE doc and was NOT silently
      // re-inserted: recovery is restore-only, never automatic.
      expect(count(rig.serializeFragment(), PENDING_LINE)).toBe(0);
      expect(count(rig.ytext.toString(), PENDING_LINE)).toBe(0);

      // The content is reachable ONLY through the timeline (checkpoint refs),
      // never the Y.Doc: a defer-exhaustion-loss row carrying the pending line.
      await vi.waitFor(async () => {
        const hist = await getDocumentHistory(shadow, { docName: 'qa009' }, CONTENT_ROOT);
        const cp = hist.entries.find((e) => e.checkpoint?.kind === 'defer-exhaustion-loss');
        expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/);
        const blob = (
          await shadowGit(shadow).raw('show', `${cp?.sha}:${CONTENT_ROOT}/qa009`)
        ).toString();
        expect(blob).toContain(PENDING_LINE); // restore-reachable payload
      });

      // No further drain re-inserts it: keep running the loop, live doc stays clean.
      rig.settle(6);
      expect(count(rig.serializeFragment(), PENDING_LINE)).toBe(0);
      expect(count(rig.ytext.toString(), PENDING_LINE)).toBe(0);
      console.log('[QA-009] checkpoint restore-reachable; live doc never auto-gains it');
    } finally {
      rig.cleanup();
    }
  });
});
