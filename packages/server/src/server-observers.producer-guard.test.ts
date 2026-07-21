/**
 * Producer guard — the read-only structural-legality watchdog at the
 * Observer-A serialize (the moment byte-fate is decided). A fresh parse of the
 * bytes about to be persisted must reconstruct the same authored content;
 * markdown never legitimately drops text on a round-trip, so a content-loss
 * verdict means the serializer emitted corrupt bytes only a fresh parser sees.
 *
 * Drives the real `setupServerObservers` drain (not the comparator in
 * isolation). A serializer that silently loses content is injected at the
 * MarkdownManager boundary via a Proxy — no module mock, no internal-call
 * assertions.
 *
 *   dev/test posture (default `bun test` NODE_ENV=test) → throw loud.
 *   packaged posture (NODE_ENV=production) → rate-limited structured log +
 *     silent checkpoint of the pre-loss source, never a throw, never a
 *     corrective write.
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { getLogger } from './logger.ts';
import { getMetrics } from './metrics.ts';
import {
  ProducerGuardViolationError,
  type SetupServerObserversOpts,
  setupServerObservers,
} from './server-observers.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

// A word the losing serializer drops. Never appears in a bounded-cardinality
// log payload, so the packaged-posture test can also assert redaction.
const LOSS_SENTINEL = 'ZZLOSSZZ';

// Mirrors the internal per-doc log cooldown (`PRODUCER_GUARD_LOG_COOLDOWN_MS`
// in server-observers.ts) — not exported, so the throttle test pins the same
// window via a controllable clock.
const PRODUCER_GUARD_COOLDOWN_MS = 5_000;

// A table whose one body cell carries the sentinel plus a keeper word: a
// serializer that drops the sentinel loses cell text while the table structure
// and the keeper survive — a pure content-loss, not a container shatter.
const DANGER_TABLE_MD = `| Col |\n| --- |\n| ${LOSS_SENTINEL} keep |\n`;
// Same danger space, nothing to lose — the non-vacuity control.
const LEGAL_TABLE_MD = `| Col |\n| --- |\n| keep only |\n`;
// Plain (non-danger) doc — exercises the danger-space gate even under a losing
// serializer, because plain block content is not round-trip-lossy.
const PLAIN_MD = `${LOSS_SENTINEL} plain paragraph\n`;

function createDoc() {
  const doc = new Y.Doc();
  return { doc, xmlFragment: doc.getXmlFragment('default'), ytext: doc.getText('source') };
}

/** Seed the fragment in one null-origin drain so Observer A sees xmlDirty. A
 *  guard throw inside the settlement handler propagates out of this call. */
function seedFragment(doc: Y.Doc, xmlFragment: Y.XmlFragment, md: string): void {
  const pmNode = schema.nodeFromJSON(mdManager.parse(md));
  doc.transact(() => {
    updateYFragment(doc, xmlFragment, pmNode, { mapping: new Map(), isOMark: new Map() });
  }, null);
}

/** MarkdownManager whose `serialize` drops every `dropText` run from its output
 *  — a serializer that silently loses content, faulted at the system boundary. */
function makeContentLosingManager(dropText: string): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: Parameters<MarkdownManager['serialize']>[0]) =>
          target.serialize(json).split(dropText).join('');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** MarkdownManager whose `serialize` strips the `<Callout>` wrapper lines,
 *  leaving the interior text. A fresh parse of that output reconstructs the
 *  text as a plain paragraph — the container vanishes but no text is lost: a
 *  structural SHATTER, not a content-loss. The guard fires ONLY on content-loss,
 *  so this must stay silent. */
function makeContainerShatteringManager(): MarkdownManager {
  return new Proxy(mdManager, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: Parameters<MarkdownManager['serialize']>[0]) =>
          target
            .serialize(json)
            .split('\n')
            .filter((line) => !/^\s*<\/?Callout/.test(line))
            .join('\n');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function baseOpts(
  o: { doc: Y.Doc; xmlFragment: Y.XmlFragment; ytext: Y.Text } & Partial<SetupServerObserversOpts>,
): SetupServerObserversOpts {
  const { doc, xmlFragment, ytext, ...rest } = o;
  return { doc, xmlFragment, ytext, mdManager, schema, ...rest };
}

function fragmentJsonString(xmlFragment: Y.XmlFragment): string {
  return JSON.stringify(yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON());
}

/** Poll for a committed checkpoint ref (the checkpoint is queued via
 *  `queueMicrotask` then written by an async git commit chain). Bounded — a
 *  timeout returns empty so the assertion fails loudly rather than hanging. */
async function waitForCheckpointRefs(shadow: ShadowHandle, timeoutMs = 3000): Promise<string[]> {
  const sg = shadowGit(shadow);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/checkpoints/')).trim();
    if (out) return out.split('\n');
    if (Date.now() >= deadline) return [];
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Producer guard (FR6) — dev/test posture throws (M2)', () => {
  test('content-losing serialize on a danger-space doc throws ProducerGuardViolationError at the drain', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'loss.md' }),
    );
    try {
      let thrown: unknown;
      try {
        seedFragment(doc, xmlFragment, DANGER_TABLE_MD);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ProducerGuardViolationError);
      expect((thrown as ProducerGuardViolationError).info.reason).toBe('content-loss');
    } finally {
      cleanup();
    }
  });

  test('faithful serialize on the same danger space does NOT fire (non-vacuity control)', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, docName: 'legal.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, LEGAL_TABLE_MD)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test('danger-space gate: a content-losing serialize on a plain doc is skipped (no fire)', () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'plain.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, PLAIN_MD)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test('a container-shatter (text preserved, container gone) does NOT fire — silent on shatter', () => {
    // Pins "fire on content-loss, silent on shatter": the serializer drops the
    // Callout wrapper but keeps its text, so a fresh parse shatters the container
    // without losing content. The guard fires only on content-loss, so no throw
    // and no producer-guard-violation event.
    const { doc, xmlFragment, ytext } = createDoc();
    const shattering = makeContainerShatteringManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: shattering, docName: 'shatter.md' }),
    );
    try {
      expect(() =>
        seedFragment(doc, xmlFragment, '<Callout type="info">\n\nkeep this text\n\n</Callout>\n'),
      ).not.toThrow();
      const fired = warn.mock.calls
        .map((call) => String(call[0]))
        .some((line) => line.includes('producer-guard-violation'));
      expect(fired).toBe(false);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });
});

describe('Producer guard (FR6) — packaged posture logs + checkpoints, never throws/corrects (QA-010)', () => {
  const SAVED_ENV = ['NODE_ENV', 'OK_RETHROW_BRIDGE_LOSS'] as const;
  let savedEnv: Partial<Record<(typeof SAVED_ENV)[number], string | undefined>>;
  let projectRoot: string;
  let shadow: ShadowHandle;

  beforeEach(async () => {
    savedEnv = {};
    for (const key of SAVED_ENV) savedEnv[key] = process.env[key];
    process.env.NODE_ENV = 'production';
    delete process.env.OK_RETHROW_BRIDGE_LOSS;

    projectRoot = await mkdtemp(resolve(tmpdir(), 'ok-producer-guard-'));
    mkdirSync(resolve(projectRoot, 'content'), { recursive: true });
    const git = simpleGit(projectRoot);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@test.com');
    shadow = await initShadowRepo(projectRoot);
  });

  afterEach(async () => {
    for (const key of SAVED_ENV) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('detects content-loss without throwing: structured log + silent checkpoint, no corrective write', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'loss.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    try {
      // Packaged posture: the drain completes without a throw.
      expect(() => seedFragment(doc, xmlFragment, DANGER_TABLE_MD)).not.toThrow();

      // Structured detection event, bounded cardinality, no raw content.
      const event = warn.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('producer-guard-violation'));
      expect(event).toBeDefined();
      expect(event as string).not.toContain(LOSS_SENTINEL);
      const parsed = JSON.parse(event as string);
      expect(parsed).toMatchObject({
        event: 'producer-guard-violation',
        docName: 'loss.md',
        reason: 'content-loss',
      });
      // The construct locator is a bounded danger-space enum, never raw content.
      expect(typeof parsed.construct).toBe('string');
      expect(parsed.construct.length).toBeGreaterThan(0);
      expect(parsed.construct).not.toContain(LOSS_SENTINEL);

      // Never corrective: the guard did not re-inject the lost text. The
      // fragment still carries it (untouched); Y.Text holds the as-computed
      // lossy body.
      expect(fragmentJsonString(xmlFragment)).toContain(LOSS_SENTINEL);
      expect(ytext.toString()).not.toContain(LOSS_SENTINEL);

      // Silent checkpoint queued + committed.
      const refs = await waitForCheckpointRefs(shadow);
      expect(refs.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  test('two distinct losses in the cooldown: one log suppressed, BOTH checkpointed, next emit carries the suppressed count', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Controllable clock so the cooldown window is deterministic (the throttle
    // reads Date.now); the checkpoint label uses `new Date()`, unaffected. The
    // checkpoint poll below is Date.now-independent, so the mock can stay live.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'throttle.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    const violations = (): Array<{ suppressedSincePrevious: number }> =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('producer-guard-violation'))
        .map((line) => JSON.parse(line));
    // Bounded poll that does NOT read Date.now (which the test mocks), so the
    // deadline logic can't stall under the frozen clock.
    const pollCheckpointRefs = async (minCount: number, tries = 80): Promise<string[]> => {
      const sg = shadowGit(shadow);
      let refs: string[] = [];
      for (let i = 0; i < tries; i++) {
        const out = (
          await sg.raw('for-each-ref', '--format=%(refname)', 'refs/checkpoints/')
        ).trim();
        refs = out ? out.split('\n') : [];
        if (refs.length >= minCount) return refs;
        await new Promise((r) => setTimeout(r, 25));
      }
      return refs;
    };
    const cell = (keep: string): string => `| Col |\n| --- |\n| ${LOSS_SENTINEL} ${keep} |\n`;
    try {
      // Loss 1 (distinct body A) fires + logs.
      seedFragment(doc, xmlFragment, cell('keepA'));
      // Loss 2 (distinct body B, distinct pre-loss) inside the cooldown: the log
      // is suppressed, but Major 2a requires the checkpoint to still be written.
      seedFragment(doc, xmlFragment, cell('keepB'));
      expect(violations()).toHaveLength(1);
      expect(violations()[0]?.suppressedSincePrevious).toBe(0);

      // The load-bearing Major 2a assertion: BOTH losses are anchored even though
      // only one logged. Pre-fix (checkpoint gated by the same cooldown), the
      // suppressed loss 2 wrote no checkpoint and this stays at one ref.
      const refs = await pollCheckpointRefs(2);
      expect(refs.length).toBeGreaterThanOrEqual(2);

      // Advance past the cooldown; loss 3 emits and carries the one suppressed.
      clock += PRODUCER_GUARD_COOLDOWN_MS + 1;
      seedFragment(doc, xmlFragment, cell('keepC'));
      const v = violations();
      expect(v).toHaveLength(2);
      expect(v[1]?.suppressedSincePrevious).toBe(1);
      // Settle loss 3's checkpoint before cleanup so its async write (and
      // counter increment) cannot straggle into a later test's window.
      expect((await pollCheckpointRefs(3)).length).toBeGreaterThanOrEqual(3);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });

  test('without a shadow repo, the violation log still fires (detection is not gated on checkpointing)', () => {
    // In production the shadow repo initializes asynchronously; a doc opened
    // before init completes hits the `!shadow` early return. Only the CHECKPOINT
    // is gated on shadow availability — the structured detection event must
    // fire regardless, or a shadow-less session loses the signal entirely.
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleanup = setupServerObservers(
      baseOpts({ doc, xmlFragment, ytext, mdManager: losing, docName: 'no-shadow.md' }),
    );
    try {
      expect(() => seedFragment(doc, xmlFragment, DANGER_TABLE_MD)).not.toThrow();
      const event = warn.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('producer-guard-violation'));
      expect(event).toBeDefined();
      expect(JSON.parse(event as string)).toMatchObject({
        event: 'producer-guard-violation',
        docName: 'no-shadow.md',
        reason: 'content-loss',
      });
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  // A repeated pre-loss source is only reachable when Y.Text returns to a prior
  // value BETWEEN losing drains — sequentially, each fire's pre-loss is the
  // previous fire's lossy body, and an identical body dedups upstream via
  // `lastGuardedBody`. The restore below stages the concurrent scenario the
  // dedup map exists for: a remote peer (external origin) putting the last-good
  // source back while the serializer keeps emitting distinct losing bodies.
  const cellBody = (keep: string): string => `| Col |\n| --- |\n| ${LOSS_SENTINEL} ${keep} |\n`;
  function restoreYtext(o: { doc: Y.Doc; ytext: Y.Text }, contents: string): void {
    o.doc.transact(() => {
      o.ytext.delete(0, o.ytext.length);
      o.ytext.insert(0, contents);
    }, 'test-external-peer');
  }

  test('an identical pre-loss source is checkpointed once — the dedup map holds (one ref, one counter)', async () => {
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The external Y.Text restore below resets the freshness-quiescence clock,
    // which also defers the producer guard (a suppressed drain's emission is
    // knowingly historical). Advance a controlled clock past the window so the
    // post-restore drain is guard-adjudicated and the dedup map is what
    // decides — the semantics this test pins.
    let clock = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'dedup.md',
        shadow: () => shadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    // Per-test signal (the warn spy is fresh per test; the metrics counter is
    // module-global, so it is asserted as a DELTA below).
    const createdEvents = (): number =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('producer-guard-checkpoint-created')).length;
    // The git ref becomes visible before the write promise's .then (which emits
    // the event + increments the counter) runs, so poll rather than asserting
    // immediately after the ref appears — the gap is wide on loaded CI runners.
    const waitForCreatedEvents = async (count: number, tries = 120): Promise<number> => {
      for (let i = 0; i < tries; i++) {
        if (createdEvents() >= count) return createdEvents();
        await new Promise((r) => setTimeout(r, 25));
      }
      return createdEvents();
    };
    try {
      // Establish a non-empty last-good source without firing (plain = no danger).
      seedFragment(doc, xmlFragment, PLAIN_MD);
      const lastGood = ytext.toString();
      // Loss 1: pre-loss = lastGood → checkpoint 1.
      seedFragment(doc, xmlFragment, cellBody('keepA'));
      expect((await waitForCheckpointRefs(shadow)).length).toBe(1);
      expect(await waitForCreatedEvents(1)).toBe(1);
      const counterAfterFirst = getMetrics().producerGuardCheckpointCreated;
      // Remote peer restores the last-good source, then a DISTINCT losing body
      // fires with the SAME pre-loss — the dedup map must skip the re-write.
      restoreYtext({ doc, ytext }, lastGood);
      expect(ytext.toString()).toBe(lastGood);
      // Past the freshness-quiescence window: the post-restore drain must be
      // guard-adjudicated so the dedup map (not the quiescence defer) decides.
      clock += 2_001;
      seedFragment(doc, xmlFragment, cellBody('keepB'));
      // Negative wait: give a (wrong) second checkpoint time to land.
      await new Promise((r) => setTimeout(r, 400));
      expect((await waitForCheckpointRefs(shadow)).length).toBe(1);
      expect(createdEvents()).toBe(1);
      expect(getMetrics().producerGuardCheckpointCreated).toBe(counterAfterFirst);
    } finally {
      nowSpy.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });

  test('a FAILED checkpoint write reopens the retry window (dedup entry cleared on failure)', async () => {
    // Regression for the dedup-before-write hole: the dedup entry is set
    // synchronously (so concurrent drains dedup), but a failed write must clear
    // it — otherwise a transient failure (disk pressure, shadow handle race)
    // permanently closes the recovery window for that pre-loss content.
    const { doc, xmlFragment, ytext } = createDoc();
    const losing = makeContentLosingManager(LOSS_SENTINEL);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logWarn = vi.spyOn(getLogger('server-observers'), 'warn');
    // A shadow whose backing directory is gone: every git op (and thus the
    // checkpoint write) rejects. Swapped for the good shadow after the failure.
    const brokenRoot = await mkdtemp(resolve(tmpdir(), 'ok-producer-guard-broken-'));
    mkdirSync(resolve(brokenRoot, 'content'), { recursive: true });
    const brokenGit = simpleGit(brokenRoot);
    await brokenGit.init();
    await brokenGit.raw('config', 'user.name', 'Test');
    await brokenGit.raw('config', 'user.email', 'test@test.com');
    const brokenShadow = await initShadowRepo(brokenRoot);
    await rm(brokenRoot, { recursive: true, force: true });
    let activeShadow = brokenShadow;
    const cleanup = setupServerObservers(
      baseOpts({
        doc,
        xmlFragment,
        ytext,
        mdManager: losing,
        docName: 'retry.md',
        shadow: () => activeShadow,
        contentRoot: 'content',
        getBranch: () => 'main',
      }),
    );
    const failureLogged = async (tries = 120): Promise<boolean> => {
      for (let i = 0; i < tries; i++) {
        const hit = logWarn.mock.calls
          .map((call) => String(call[1]))
          .some((line) => line.includes('checkpoint write failed'));
        if (hit) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };
    try {
      seedFragment(doc, xmlFragment, PLAIN_MD);
      const lastGood = ytext.toString();
      // Loss 1 against the broken shadow: the write fails; the dedup entry for
      // this pre-loss must be cleared so the content stays recoverable.
      seedFragment(doc, xmlFragment, cellBody('keepA'));
      expect(await failureLogged()).toBe(true);
      // Shadow recovers; the same pre-loss recurs via the remote-peer restore.
      activeShadow = shadow;
      restoreYtext({ doc, ytext }, lastGood);
      // Past the freshness-quiescence window (the restore reset it): the
      // retry drain must be guard-adjudicated for the re-write to be
      // attempted at all.
      const retryClockBase = Date.now();
      const retryNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => retryClockBase + 2_001);
      try {
        seedFragment(doc, xmlFragment, cellBody('keepB'));
      } finally {
        retryNowSpy.mockRestore();
      }
      // Pre-fix (entry never cleared) this stays empty forever — the recovery
      // window is permanently closed and the assertion fails.
      expect((await waitForCheckpointRefs(shadow)).length).toBeGreaterThanOrEqual(1);
    } finally {
      logWarn.mockRestore();
      warn.mockRestore();
      cleanup();
    }
  });
});
