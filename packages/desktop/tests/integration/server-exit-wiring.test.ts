/**
 * Bypass-pin — `index.ts` must still wire the packaged detached server's exit
 * to the observer, exactly once.
 *
 * The mapping, the record shape and the registration are all covered by tests
 * that call the production functions directly (`server-exit-observer.test.ts`,
 * `server-exit-record.test.ts`, `detached-lifecycle.test.ts`). Two facts those
 * cannot reach: that `spawnDetachedServer` calls `attachServerExitObserver` at
 * all, and that it calls it once, on the spawned child. `index.ts` is ~9,000
 * lines, imports `electron` at module scope so it cannot be imported by a test,
 * and the spawn closure is actively reworked — a rebase that drops the call,
 * duplicates it, reorders it after an early return, or swaps the shared
 * `getServerExitRecorder()` singleton for a fresh recorder leaves every other
 * test green and the diagnostic dead, resurfacing months later as a triager
 * opening a packaged bundle and finding the file absent again.
 *
 * A tight grep, not a structural parse — same posture and rationale as the
 * bypass-pin in `dock-visibility.test.ts`, which guards the same spawn closure.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexTsPath = resolve(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)));
const src = readFileSync(indexTsPath, 'utf-8');

const FIX = (what: string): string =>
  `\n[server-exit] ${what}\n\n` +
  `The packaged build spawns the project server with plain child_process.spawn, which no other\n` +
  `mechanism observes: app.on('child-process-gone') guards on details.type === 'Utility' (structurally\n` +
  `unreachable for an ordinary OS process) and the utilityProcess exit handler that records the death in\n` +
  `dev never runs. Without this wiring every packaged bug report is missing last-server-exit.json — the\n` +
  `one file that answers "did the server crash, or was it shut down on purpose". The full rationale is\n` +
  `in the header of packages/desktop/src/main/server-exit-observer.ts.\n`;

describe('packaged detached-server exit wiring (bypass-pin)', () => {
  test('index.ts registers the exit observer on the spawned child, exactly once', () => {
    // Anchored on `childRef`: an unanchored match would accept an attach to any
    // handle, and a `utilityProcess` satisfies `ObservableChild` structurally —
    // so that mis-wire would type-check and ship a record describing a
    // pty-host's death as the project server's. The count is what catches a
    // duplicated call, which would double both the record and the log line.
    const calls = src.match(/attachServerExitObserver\s*\(\s*childRef\b/g) ?? [];
    expect(
      calls.length,
      FIX(
        `index.ts has ${calls.length} \`attachServerExitObserver(childRef, …)\` call(s); expected exactly 1.`,
      ),
    ).toBe(1);
  });

  test('the observer records through the shared recorder singleton', () => {
    // A fresh `createServerExitRecorder()` here would still write records, but
    // would break the reason-correlation slot `app.on('child-process-gone')`
    // patches through and would double the recorder's state.
    const wiring =
      /attachServerExitObserver\s*\([\s\S]{0,600}?getServerExitRecorder\(\)\.recordExit/;
    expect(
      src,
      FIX('the exit observer no longer records through getServerExitRecorder().'),
    ).toMatch(wiring);
  });

  test('the observer logs on the server-exit subsystem', () => {
    const wiring = /attachServerExitObserver\s*\([\s\S]{0,600}?getLogger\(['"]server-exit['"]\)/;
    expect(src, FIX("the exit observer's logger is no longer getLogger('server-exit').")).toMatch(
      wiring,
    );
  });

  test('the listener is still registered before unref()', () => {
    // `unref()` releases the event-loop reference, not listeners, so this is not
    // a correctness requirement on its own — it is pinned because an acceptance
    // criterion states it, and because keeping the two adjacent is what makes
    // the spawn site readable.
    const attachAt = src.indexOf('attachServerExitObserver(childRef');
    const unrefAt = src.indexOf('childRef.unref()');
    expect(unrefAt, FIX('childRef.unref() call not found.')).toBeGreaterThan(-1);
    expect(attachAt, FIX('the exit observer is registered after unref().')).toBeLessThan(unrefAt);
  });
});
