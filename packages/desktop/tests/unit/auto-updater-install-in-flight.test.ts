import { describe, expect, test } from 'vitest';
import { installMayStillBeRunning, installWasInFlightDuring } from '../../src/main/auto-updater.ts';
import type { AppState } from '../../src/main/state-store.ts';
import { emptyState } from '../../src/main/state-store.ts';

const GRACE_MS = 30 * 60 * 1000;
const MAX_BOOTS = 3;
const NOW = Date.parse('2026-08-23T23:12:51.339Z');
const HANDOFF = Date.parse('2026-08-23T23:10:28.727Z');

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...emptyState(), ...overrides };
}

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
    expect(check(state({ attemptedInstall: '0.61.3' }))).toBeNull();
  });

  test('the staging moment stands in when no live process recorded the handoff', () => {
    const inFlight = check(
      state({ attemptedInstall: '0.61.3', versionPendingInstallStagedAt: NOW - 60_000 }),
    );

    expect(inFlight?.attemptedVersion).toBe('0.61.3');
    expect(inFlight?.recordedHandoff).toBe(false);
  });

  test("the staging moment is the caller's to supply, not read off the state", () => {
    const afterStalePendingClear = state({
      attemptedInstall: '0.54.0-beta.1',
      attemptedInstallHandoffAt: null,
      versionPendingInstallStagedAt: null,
    });
    const snapshotTakenBeforeTheClear = NOW - 60_000;

    expect(
      installMayStillBeRunning(afterStalePendingClear, NOW, snapshotTakenBeforeTheClear),
    ).not.toBeNull();
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
    expect(
      check(state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW + 60_000 })),
    ).toBeNull();
  });

  test('a handoff that is not a number reads as no claim rather than a fresh one', () => {
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

    const spent = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: HANDOFF,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });
    expect(check(spent)).toBeNull();
  });
});

describe('installWasInFlightDuring', () => {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  function during(s: AppState, deathFromMs: number, deathToMs: number) {
    return installWasInFlightDuring(s, { deathFromMs, deathToMs }, s.versionPendingInstallStagedAt);
  }

  test('a handoff before the span still counts while the span starts inside the window', () => {
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW - 30 * 60_000 });

    expect(during(s, NOW - 25 * 60_000, NOW)).not.toBeNull();
  });

  test('a handoff older than the grace at the start of the span is closed', () => {
    const s = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 25 * 60_000 - GRACE_MS - 1,
    });

    expect(during(s, NOW - 25 * 60_000, NOW)).toBeNull();
  });

  test('a window that opens and closes inside the span counts, however long the span', () => {
    const handoffAt = NOW - TWO_HOURS_MS + 45_000;
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: handoffAt });

    expect(during(s, NOW - TWO_HOURS_MS, NOW)).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt,
      recordedHandoff: true,
    });
  });

  test('a handoff after the span ended is not in flight during it', () => {
    const s = state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW + 60_000 });

    expect(during(s, NOW - 60 * 60_000, NOW)).toBeNull();
  });

  test('a span whose start is later than its end collapses to its end', () => {
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
    const stale = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60 * 60 * 1000,
    });

    expect(during(stale, NOW - TWO_HOURS_MS, Number.NaN)).toBeNull();
  });

  test('a span start that is not a number collapses onto the end', () => {
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
    const s = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });

    expect(during(s, NOW, NOW)).toEqual(check(s));
    expect(during(s, NOW, NOW)).toBeNull();
    const held = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - 5 * 60_000,
    });
    expect(during(held, NOW, NOW)).toEqual(check(held));
    expect(during(held, NOW, NOW)).not.toBeNull();
  });

  test('a handoff inherited from an earlier boot suppresses within the grace of the span', () => {
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
