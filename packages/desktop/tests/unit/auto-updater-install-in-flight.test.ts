import { describe, expect, test } from 'vitest';
import { installMayStillBeRunning, installWasInFlightDuring } from '../../src/main/auto-updater.ts';
import type { AppState } from '../../src/main/state-store.ts';
import { emptyState } from '../../src/main/state-store.ts';

/**
 * Pure-helper coverage for the "an install may still be running" predicate.
 *
 * Two callers depend on this bound and they fail in opposite directions, which
 * is why the boundaries below are pinned rather than left to the integration
 * rig. Too loose and crash detection suppresses a genuine crash forever behind
 * a stale record, which is the risk of keying on `attemptedInstall` alone. Too
 * tight and a session the installer really did kill gets reported to the user
 * as a crash, which is the bug this predicate exists to prevent.
 *
 * The boot-reconciliation side of this predicate is exercised end to end by the
 * FakeUpdater rig in `tests/integration/auto-updater.test.ts`; this file owns
 * the boundary arithmetic.
 */

const GRACE_MS = 30 * 60 * 1000;
const MAX_BOOTS = 3;
const NOW = Date.parse('2026-08-23T23:12:51.339Z');
/** A handoff from a real field report, recorded 142.6s before detection ran. */
const HANDOFF = Date.parse('2026-08-23T23:10:28.727Z');

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...emptyState(), ...overrides };
}

/**
 * The ordinary call shape: a caller reading state that nothing has mutated
 * passes the staging stamp straight through. The reconciliation's shape, where
 * the two diverge, is pinned separately below.
 */
function check(s: AppState, nowMs: number = NOW) {
  return installMayStillBeRunning(s, nowMs, s.versionPendingInstallStagedAt);
}

describe('installMayStillBeRunning', () => {
  test('an install handed off moments ago is in flight', () => {
    const inFlight = check(
      state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: HANDOFF }),
    );

    expect(inFlight).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt: HANDOFF,
      recordedHandoff: true,
    });
  });

  test('nothing attempted means nothing in flight', () => {
    expect(check(state({ attemptedInstallHandoffAt: HANDOFF }))).toBeNull();
  });

  test('an attempt with no handoff and no staging moment cannot be reasoned from', () => {
    // Neither witness survived. Claiming an install is in flight on no evidence
    // would suppress every dirty shutdown for as long as the record stands.
    expect(check(state({ attemptedInstall: '0.61.3' }))).toBeNull();
  });

  test('the staging moment stands in when no live process recorded the handoff', () => {
    // A session that reached neither commit point, neither the "Relaunch now"
    // click nor `before-quit`, never stamps a handoff of its own.
    const inFlight = check(
      state({ attemptedInstall: '0.61.3', versionPendingInstallStagedAt: NOW - 60_000 }),
    );

    expect(inFlight?.attemptedVersion).toBe('0.61.3');
    expect(inFlight?.recordedHandoff).toBe(false);
  });

  test("the staging moment is the caller's to supply, not read off the state", () => {
    // The regression this parameter exists to prevent. The boot reconciliation
    // runs its stale-pending clear first, which nulls the staging stamp on
    // `state`; the moment the artifact was really staged survives only in the
    // snapshot the caller took beforehand. Reading the cleared field instead
    // condemns an install that is still running.
    const afterStalePendingClear = state({
      attemptedInstall: '0.54.0-beta.1',
      // Unobserved quit: nothing stamped a handoff, so the staging moment is
      // the only lower bound there is.
      attemptedInstallHandoffAt: null,
      versionPendingInstallStagedAt: null,
    });
    const snapshotTakenBeforeTheClear = NOW - 60_000;

    expect(
      installMayStillBeRunning(afterStalePendingClear, NOW, snapshotTakenBeforeTheClear),
    ).not.toBeNull();
    // Same state, read the way the bug read it.
    expect(installMayStillBeRunning(afterStalePendingClear, NOW, null)).toBeNull();
  });

  test('a recorded handoff wins over the staging fallback', () => {
    const inFlight = check(
      state({
        attemptedInstall: '0.61.3',
        attemptedInstallHandoffAt: HANDOFF,
        versionPendingInstallStagedAt: NOW - GRACE_MS * 2,
      }),
    );

    // The staging moment is far outside the window; the real handoff is not,
    // and it is the tighter and truer of the two.
    expect(inFlight?.handoffAt).toBe(HANDOFF);
    expect(inFlight?.recordedHandoff).toBe(true);
  });

  test('the grace window is inclusive at its edge and closed past it', () => {
    const atEdge = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - GRACE_MS,
    });
    expect(check(atEdge)).not.toBeNull();

    const pastEdge = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - GRACE_MS - 1,
    });
    expect(check(pastEdge)).toBeNull();
  });

  test('a handoff in the future is not treated as freshly handed off', () => {
    // `Date.now()` is wall-clock and this record crosses a process quit, so an
    // NTP correction or a VM resume can leave the stamp ahead of now.
    expect(
      check(state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW + 60_000 })),
    ).toBeNull();
  });

  test('a handoff that is not a number reads as no claim rather than a fresh one', () => {
    // The failure here is one-directional and silent: every comparison against
    // `NaN` is false, so an unrejected one passes the staleness bound by
    // failing it and suppresses whatever the record's real age, then reaches
    // the breadcrumb as a moment that cannot be formatted. Nothing produces
    // this today, because the state loader coerces these fields. Both public
    // entry points funnel through the same age helper, so both are pinned.
    const nonNumeric = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: Number.NaN,
    });
    expect(check(nonNumeric)).toBeNull();
    expect(
      installWasInFlightDuring(nonNumeric, { deathFromMs: NOW - 60_000, deathToMs: NOW }, null),
    ).toBeNull();
  });

  test('the hold terminates once the boot budget is spent', () => {
    const lastBoot = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: HANDOFF,
      attemptedInstallDeferredBoots: MAX_BOOTS - 1,
    });
    expect(check(lastBoot)).not.toBeNull();

    // Without this bound, an install that never lands keeps looking newly
    // handed off — electron-updater re-arms `update-downloaded` from its cache
    // and the next quit stamps a fresh moment.
    const spent = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: HANDOFF,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });
    expect(check(spent)).toBeNull();
  });
});

/**
 * The span-shaped sibling. Crash detection knows only that the previous
 * session was alive at one moment and gone by another, so its question is
 * whether the in-flight window overlaps that span rather than whether it
 * covers one chosen instant. The overlap is reduced to a single anchor and
 * delegated, so every boundary above still owns itself and none is restated
 * here. What these pin is the reduction.
 */
describe('installWasInFlightDuring', () => {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  function during(s: AppState, deathFromMs: number, deathToMs: number) {
    return installWasInFlightDuring(s, { deathFromMs, deathToMs }, s.versionPendingInstallStagedAt);
  }

  test('a handoff before the span still counts while the span starts inside the window', () => {
    // The window opened before the session was last seen alive and had not
    // closed by then, so the install really was running during the span.
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW - 30 * 60_000 });

    expect(during(s, NOW - 25 * 60_000, NOW)).not.toBeNull();
  });

  test('a handoff older than the grace at the start of the span is closed', () => {
    // Nothing about a long span can revive a window that had already closed
    // before the earliest moment the span covers.
    const s = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 25 * 60_000 - GRACE_MS - 1,
    });

    expect(during(s, NOW - 25 * 60_000, NOW)).toBeNull();
  });

  test('a window that opens and closes inside the span counts, however long the span', () => {
    // The shape the instant-shaped predicate cannot answer at either end. The
    // handoff lands after the last heartbeat and the window closes hours before
    // the reopen, so both ends of the span read empty while the truth is that
    // the install was running for part of it.
    const handoffAt = NOW - TWO_HOURS_MS + 45_000;
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: handoffAt });

    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt,
      recordedHandoff: true,
    });
  });

  test('a handoff after the span ended is not in flight during it', () => {
    // A stamp ahead of the whole span is the wall-clock correction the instant
    // predicate already refuses, and clamping must not launder it into a yes.
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW + 60_000 });

    expect(during(s, NOW - 60 * 60_000, NOW)).toBeNull();
  });

  test('a span whose start is later than its end collapses to its end', () => {
    // A lower bound that postdates the boot which read it carries no usable
    // information, so the question falls back to the single instant the caller
    // can vouch for rather than inverting into a span that never happened.
    const fresh = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
    });
    const stale = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - GRACE_MS - 1,
    });

    expect(during(fresh, NOW + 60 * 60_000, NOW)).toEqual(check(fresh));
    expect(during(stale, NOW + 60 * 60_000, NOW)).toEqual(check(stale));
  });

  test('a span end that is not a number takes the question out of play', () => {
    // Nothing is left to anchor to when it is the end that is unusable, and
    // every comparison against NaN is false, so an unguarded one would pass the
    // staleness gate by failing it and hold a record the grace retired hours
    // ago. The answer is no claim at all.
    const stale = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60 * 60 * 1000,
    });

    expect(during(stale, NOW - TWO_HOURS_MS, Number.NaN)).toBeNull();
  });

  test('a span start that is not a number collapses onto the end', () => {
    // The end is still an instant the caller can vouch for, so the question
    // degrades to that single moment rather than being abandoned, the same
    // treatment a start that postdates its end already gets. Two rows, because
    // they pin different halves: the fresh handoff shows the collapse landing
    // on the end rather than the question being refused, and the stale one is
    // what an unguarded `Math.min` would carry through as NaN and suppress.
    const fresh = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
    });
    const stale = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60 * 60 * 1000,
    });

    expect(during(fresh, Number.NaN, NOW)).toEqual(check(fresh));
    expect(during(stale, Number.NaN, NOW)).toBeNull();
  });

  test('the boot budget does not bound a span that covers an interval', () => {
    // A widened span drops the cap, and the same fixture is refused in the
    // instant frame, which is where the count belongs.
    // `installWasInFlightDuring` carries why.
    const s = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - TWO_HOURS_MS + 45_000,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });

    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt: NOW - TWO_HOURS_MS + 45_000,
      recordedHandoff: true,
    });
    expect(check(s)).toBeNull();
  });

  test('a staged commit with nothing stamped still answers at the instant', () => {
    // The branch that carries no stamp at all, which nothing else in this block
    // reaches. The staging moment is the only date available, so the span
    // collapses onto its later end and the answer is the one the instant-shaped
    // predicate gives. `recordedHandoff` is asserted because it is what a
    // triager branches on to know which frame produced the verdict.
    const stagedAt = NOW - 5 * 60_000;
    const s = state({ attemptedInstall: '0.61.3', versionPendingInstallStagedAt: stagedAt });

    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt: stagedAt,
      recordedHandoff: false,
    });
    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toEqual(check(s));
  });

  test('the boot budget still bounds the span question with nothing stamped', () => {
    // The other half of the same branch. Where the anchor is this boot's own
    // clock the count is coherent again, and it is the only bound that
    // terminates the hold there, for the re-arm reason the cap constant sets
    // out. Answering as the instant frame does is what keeps this path
    // unchanged by the span reduction.
    const stagedAt = NOW - 5 * 60_000;
    const s = state({
      attemptedInstall: '0.61.3',
      versionPendingInstallStagedAt: stagedAt,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });

    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toBeNull();
    expect(check(s)).toBeNull();
  });

  test('the boot budget bounds a stamped handoff whose span floor collapsed', () => {
    // The stamp is not what the cap turns on. A sentinel carrying no usable
    // heartbeat leaves the caller passing its own clock as both ends, so even a
    // stamped handoff is asked at the detecting instant, which is the frame the
    // count belongs to. Gating on the stamp instead would drop the bound here
    // and suppress on a boot the instant predicate refuses, which is the one
    // direction that fails toward silence.
    const s = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });

    expect(during(s, NOW, NOW)).toEqual(check(s));
    expect(during(s, NOW, NOW)).toBeNull();
    // Under the grace and under the cap, the same collapsed span still answers.
    const held = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
    });
    expect(during(held, NOW, NOW)).toEqual(check(held));
    expect(during(held, NOW, NOW)).not.toBeNull();
  });

  test('a handoff inherited from an earlier boot suppresses within the grace of the span', () => {
    // The widening this reduction accepts, pinned rather than left implicit. A
    // stamp no longer describing anything running still suppresses a death it
    // sits within half an hour of, because nothing in the record distinguishes
    // it from one that does. The grace is what keeps that to half an hour: the
    // same stamp a minute older is refused.
    const inside = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 20 * 60_000,
    });
    const outside = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 20 * 60_000 - GRACE_MS - 1,
    });

    expect(during(inside, NOW - 60_000, NOW)).not.toBeNull();
    expect(during(outside, NOW - 60_000, NOW)).toBeNull();
  });
});
