/**
 * Bypass-pin: `index.ts` must still forward crash detection's death span to
 * the updater untouched.
 *
 * The reduction itself, the clamp arithmetic and the ladder that derives the
 * span are all covered by tests that call the production functions directly
 * (`auto-updater-install-in-flight.test.ts`, `crash-detection.test.ts`). The
 * one fact those cannot reach is what the boot closure actually passes.
 * `index.ts` is ~9,000 lines and imports `electron` at module scope, so no test
 * can import it, and TypeScript will not help here: parameter-count
 * assignability accepts a zero-argument closure against a one-required-parameter
 * signature, so a closure that ignores the span and reads this boot's clock
 * type-checks. That mis-wiring breaks the fix with every other test green. It
 * narrows the span the question is asked over, collapsing it onto this boot,
 * and a narrower span can only suppress less. So it withholds no prompt that
 * was owed. It arms ones that were not, which is the symptom this fix exists to
 * remove.
 *
 * Transposed bounds are the compiler's to catch, not this pin's: the span is one
 * argument with named fields, so there is no positional pair to swap. The pin
 * therefore only has to cover forwarding.
 *
 * What a text match cannot see is where the snapshot came from, so the second
 * test asserts the one ordering the first depends on. It compares text
 * positions, which stand in for execution order here because the snapshot runs
 * synchronously in `bootPrimaryInstance`'s body while the updater boot is
 * deferred into the `whenReady` continuation further down it. A synchronous
 * statement always precedes that continuation whatever the text order says.
 * Moving the snapshot INTO that continuation below the updater boot, or into a
 * helper declared above its call site, would preserve the text order and invert
 * the real one, which is the same argument for the extraction below.
 *
 * Everything else about the closure remains outside both: this is a stopgap for
 * a composition root no test can import, not a substitute for constructing the
 * deps and checking the verdict, which would need the dep construction lifted
 * into a module of its own.
 *
 * A tight grep, not a structural parse, matching the posture and rationale of
 * the bypass-pins in `server-exit-wiring.test.ts` and `dock-visibility.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[install-in-flight] ${what}\n\n` +
  `Crash detection asks whether an update install was in flight during the span the previous\n` +
  `session died in. The boot closure in index.ts is the only place that span reaches the updater,\n` +
  `and it must forward the span it was handed. Reading this boot's clock instead type-checks and\n` +
  `narrows the span, which fabricates crash prompts the app never owed. The full rationale is in\n` +
  `the JSDoc of installWasInFlightDuring in auto-updater.ts.\n`;

describe('install-in-flight death-span wiring (bypass-pin)', () => {
  test('index.ts forwards the span it was handed to the updater', () => {
    // Anchored end to end rather than on the callee alone: an unanchored match
    // would accept a closure that names the parameter and then passes something
    // else, which is exactly the reversion this guards. Match-counted like the
    // sibling pin, so a second wiring added elsewhere has to be looked at
    // rather than silently satisfying this one.
    //
    // The back-reference captures the identifier alone, not the padding around
    // it. Capturing the padding too would make the pin formatting-sensitive: it
    // would then demand the same spacing at both the parameter and the argument,
    // so a reformatted call site would red CI claiming the span is no longer
    // forwarded when it still is.
    const wiring =
      /installInFlight:\s*\(\s*(\w+)\s*\)\s*=>\s*installWasInFlightDuring\(\s*bootStateSnapshot\s*,\s*\1\s*,/g;
    expect(
      (src.match(wiring) ?? []).length,
      FIX('index.ts no longer forwards the death span straight through to the updater.'),
    ).toBe(1);
    // The third argument is pinned in the same shape and for a stronger reason
    // than the second: `appState` is `emptyState()` this early in boot, so a
    // closure reading the staging stamp off it would pass null on every boot and
    // silently kill the whole stampless branch, which is the win32 field shape.
    // Nothing else covers it: the unit suites construct their own closures and
    // pass the stamp by hand.
    const stagingStamp =
      /installWasInFlightDuring\(\s*bootStateSnapshot\s*,\s*\w+\s*,\s*bootStateSnapshot\.versionPendingInstallStagedAt\s*,?\s*\)/g;
    expect(
      (src.match(stagingStamp) ?? []).length,
      FIX('index.ts no longer reads the staging stamp off the pre-reconciliation snapshot.'),
    ).toBe(1);
  });

  test('the state snapshot is taken before the updater boots', () => {
    // The argument name above is only worth pinning while the binding still
    // holds a pre-reconciliation read: the stale-pending clear nulls
    // `versionPendingInstallStagedAt`, which is the whole lower bound on the
    // stampless path. A refactor moving the load below the updater boot leaves
    // the regex above matching verbatim, so the ordering is asserted on its
    // own rather than left implied by it.
    // Anchored on the assignment rather than on `bootAutoUpdater(` alone: the
    // file's boot-order header names that function in prose, and a single
    // space removed from it would move this anchor into a comment and fire the
    // assertion below with a cause that never happened.
    const snapshotAt = src.indexOf('const bootStateSnapshot = loadAppState()');
    const updaterBootAt = src.indexOf('autoUpdaterHandle = await bootAutoUpdater(');
    expect(
      snapshotAt,
      FIX(
        'index.ts no longer takes its state snapshot with `const bootStateSnapshot = loadAppState()`.',
      ),
    ).toBeGreaterThan(-1);
    expect(
      updaterBootAt,
      FIX(
        'index.ts no longer awaits bootAutoUpdater into autoUpdaterHandle, so this pin cannot see the ordering.',
      ),
    ).toBeGreaterThan(-1);
    expect(
      snapshotAt,
      FIX(
        'the state snapshot is now taken after the updater boots, so it no longer carries the staging stamp.',
      ),
    ).toBeLessThan(updaterBootAt);
  });
});
