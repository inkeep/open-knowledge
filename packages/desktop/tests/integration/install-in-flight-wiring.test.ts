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
    const wiring =
      /installInFlight:\s*\(\s*(\w+)\s*\)\s*=>\s*installWasInFlightDuring\(\s*bootStateSnapshot\s*,\s*\1\s*,/g;
    expect(
      (src.match(wiring) ?? []).length,
      FIX('index.ts no longer forwards the death span straight through to the updater.'),
    ).toBe(1);
    const stagingStamp =
      /installWasInFlightDuring\(\s*bootStateSnapshot\s*,\s*\w+\s*,\s*bootStateSnapshot\.versionPendingInstallStagedAt\s*,?\s*\)/g;
    expect(
      (src.match(stagingStamp) ?? []).length,
      FIX('index.ts no longer reads the staging stamp off the pre-reconciliation snapshot.'),
    ).toBe(1);
  });

  test('the state snapshot is taken before the updater boots', () => {
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
