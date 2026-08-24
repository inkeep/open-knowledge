import { describe, expect, test } from 'vitest';
import { installMayStillBeRunning } from '../../src/main/auto-updater.ts';
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

function state(overrides: Partial<ReturnType<typeof emptyState>> = {}) {
  return { ...emptyState(), ...overrides };
}

describe('installMayStillBeRunning', () => {
  test('an install handed off moments ago is in flight', () => {
    const inFlight = installMayStillBeRunning(
      state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: HANDOFF }),
      NOW,
    );

    expect(inFlight).toEqual({
      attemptedVersion: '0.61.3',
      handoffAt: HANDOFF,
      recordedHandoff: true,
    });
  });

  test('nothing attempted means nothing in flight', () => {
    expect(installMayStillBeRunning(state({ attemptedInstallHandoffAt: HANDOFF }), NOW)).toBeNull();
  });

  test('an attempt with no handoff and no staging moment cannot be reasoned from', () => {
    // Neither witness survived. Claiming an install is in flight on no evidence
    // would suppress every dirty shutdown for as long as the record stands.
    expect(installMayStillBeRunning(state({ attemptedInstall: '0.61.3' }), NOW)).toBeNull();
  });

  test('the staging moment stands in when no live process recorded the handoff', () => {
    // A session killed mid-flight never quits, so it never stamps a handoff —
    // the path the macOS instances this class was first reported from take.
    const inFlight = installMayStillBeRunning(
      state({ attemptedInstall: '0.61.3', versionPendingInstallStagedAt: NOW - 60_000 }),
      NOW,
    );

    expect(inFlight?.attemptedVersion).toBe('0.61.3');
    expect(inFlight?.recordedHandoff).toBe(false);
  });

  test('a recorded handoff wins over the staging fallback', () => {
    const inFlight = installMayStillBeRunning(
      state({
        attemptedInstall: '0.61.3',
        attemptedInstallHandoffAt: HANDOFF,
        versionPendingInstallStagedAt: NOW - GRACE_MS * 2,
      }),
      NOW,
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
    expect(installMayStillBeRunning(atEdge, NOW)).not.toBeNull();

    const pastEdge = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: NOW - GRACE_MS - 1,
    });
    expect(installMayStillBeRunning(pastEdge, NOW)).toBeNull();
  });

  test('a handoff in the future is not treated as freshly handed off', () => {
    // `Date.now()` is wall-clock and this record crosses a process quit, so an
    // NTP correction or a VM resume can leave the stamp ahead of now.
    expect(
      installMayStillBeRunning(
        state({ attemptedInstall: '0.61.3', attemptedInstallHandoffAt: NOW + 60_000 }),
        NOW,
      ),
    ).toBeNull();
  });

  test('the hold terminates once the boot budget is spent', () => {
    const lastBoot = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: HANDOFF,
      attemptedInstallDeferredBoots: MAX_BOOTS - 1,
    });
    expect(installMayStillBeRunning(lastBoot, NOW)).not.toBeNull();

    // Without this bound, an install that never lands keeps looking newly
    // handed off — electron-updater re-arms `update-downloaded` from its cache
    // and the next quit stamps a fresh moment.
    const spent = state({
      attemptedInstall: '0.61.3',
      attemptedInstallHandoffAt: HANDOFF,
      attemptedInstallDeferredBoots: MAX_BOOTS,
    });
    expect(installMayStillBeRunning(spent, NOW)).toBeNull();
  });
});
