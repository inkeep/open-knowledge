/**
 * Cold-launch boot-restore smoke — the ONE tier that can observe what a Finder
 * "Open With" actually does to the initial window set.
 *
 * **Why this file does not use `_electron.launch`.** Every other smoke file
 * launches Electron directly and then fires `open(1)` at the already-running
 * app. That exercises the warm `open-url` path. It structurally CANNOT exercise
 * the cold one: a direct launch delivers the target via `process.argv` (the
 * `second-instance` path), never as the `open-file` / `open-url` Apple Event
 * that macOS sends when Launch Services starts a not-yet-running app. The
 * boot-restore decision reads its launch flag behind a settle barrier built for
 * exactly that asynchronous Apple-Event delivery, so a direct launch tests the
 * barrier's fast path and nothing else. Here the app is started BY `open(1)`,
 * which is the real thing.
 *
 * **The precondition is produced by the app, not written by the test.** Each
 * case first launches with a file that lives inside a project, then quits
 * cleanly so the app writes its own `pendingWindowRestore` snapshot. Only then
 * does the case do the launch under test.
 *
 * Two earlier revisions wrote `state.json` directly instead. Both failed in CI
 * with `snapshotWindowCount: 0` — the app booted from a different `state.json`
 * than the one seeded, so the precedence under test was never exercised. The
 * first revision moved `userData` by overriding `HOME`; removing that override
 * did not fix it, which means the test cannot reliably predict where a packaged
 * build resolves `app.getPath('userData')` on an arbitrary machine. Letting the
 * app produce and consume its own snapshot removes the need to know: wherever
 * it keeps state, it is the same place across the two launches.
 *
 * That also buys real coverage the seeded version never had — the clean-exit
 * snapshot WRITE path is now exercised, not assumed — and it means the suite no
 * longer reads or rewrites the developer's own `state.json`.
 *
 * **The oracle is the main process's structured log, not the renderer.** The
 * app is not ours to attach to, so each case asserts on `boot-restore decision`
 * (`urlLaunch`, `action`, `snapshotWindowCount`). The log is shared across
 * launches, so entries are selected by recency against a timestamp taken
 * immediately before each launch.
 *
 * Packaged-only by construction: an unpackaged `out/main/index.js` has no
 * bundle for Launch Services to start.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { resolveDesktopTarget } from './_helpers/launch-desktop';

const TARGET = resolveDesktopTarget({ requirePackaged: true });
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

/** `OpenKnowledge.app` → `OpenKnowledge`, the process name `pkill`/`pgrep` use. */
const APP_NAME = TARGET.appPath ? basename(TARGET.appPath, '.app') : 'OpenKnowledge';
/** Shared across launches; entries are selected by recency, never by isolation. */
const LOG_DIR = join(process.env.HOME ?? '', '.ok', 'logs');

/** A cold launch is only cold if nothing holds the single-instance lock. */
function appIsRunning(): boolean {
  try {
    execFileSync('pgrep', ['-x', APP_NAME], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function waitForExit(): void {
  const deadline = Date.now() + 15_000;
  while (appIsRunning() && Date.now() < deadline) {
    execFileSync('sleep', ['0.25']);
  }
}

/**
 * Quit via AppleScript rather than a signal. The snapshot this suite depends on
 * is written on the app's clean-exit path; a `pkill` is not guaranteed to reach
 * it, and a missed snapshot would look like a precedence failure.
 */
function quitAppCleanly(): void {
  try {
    execFileSync('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { stdio: 'pipe' });
  } catch {
    // Not running, or refused the Apple Event. The force path below covers it.
  }
  waitForExit();
  if (appIsRunning()) {
    try {
      execFileSync('pkill', ['-x', APP_NAME], { stdio: 'pipe' });
    } catch {
      // Already gone.
    }
    waitForExit();
  }
}

/**
 * A project with one markdown file in it. Opening that file cold gives the app
 * a project window, which is what the clean-exit snapshot then records.
 */
function makeProjectFixture(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-cold-launch-project-')));
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  const file = join(dir, 'note.md');
  writeFileSync(file, '# Project note\n');
  return { dir, file };
}

function makeLooseFile(): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-cold-launch-loose-')));
  const file = join(dir, 'standalone.md');
  writeFileSync(file, '# Standalone\n\nOutside every project.\n');
  return { dir, file };
}

interface BootRestoreDecisionLog {
  urlLaunch: boolean;
  action: string;
  snapshotWindowCount: number;
}

function readLogLinesSince(sinceMs: number): Array<Record<string, unknown>> {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => f.startsWith('desktop.'))
    .flatMap((f) =>
      readFileSync(join(LOG_DIR, f), 'utf8')
        .split('\n')
        .flatMap((line) => {
          if (line.trim().length === 0) return [];
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            const t = typeof entry.time === 'string' ? Date.parse(entry.time) : Number.NaN;
            return Number.isFinite(t) && t >= sinceMs ? [entry] : [];
          } catch {
            return [];
          }
        }),
    );
}

async function waitForBootDecision(sinceMs: number): Promise<BootRestoreDecisionLog> {
  let found: Record<string, unknown> | undefined;
  await expect(() => {
    found = readLogLinesSince(sinceMs).find((e) => e.msg === 'boot-restore decision');
    expect(
      found,
      `no boot-restore decision logged since ${new Date(sinceMs).toISOString()}`,
    ).toBeDefined();
  }).toPass({ timeout: 60_000, intervals: [500] });
  return found as unknown as BootRestoreDecisionLog;
}

function launchViaLaunchServices(target: string): number {
  const since = Date.now();
  execFileSync('open', ['-a', TARGET.appPath as string, target], { stdio: 'pipe' });
  return since;
}

/**
 * Give the app a non-empty clean-exit snapshot: open a file inside a project so
 * a project window exists, then quit cleanly so that window is recorded.
 * Returns nothing — the snapshot lives in the app's own userData, wherever that
 * is, which is precisely what this test declines to assume.
 */
async function establishRestoreSnapshot(projectFile: string): Promise<void> {
  quitAppCleanly();
  const since = launchViaLaunchServices(projectFile);
  await waitForBootDecision(since);
  // The window opens after the decision is logged; give it a moment to exist so
  // the clean exit has something to record.
  execFileSync('sleep', ['6']);
  quitAppCleanly();
}

test.describe('cold launch with an explicit target owns the initial window set', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Launch Services + Apple Events are macOS-only.');
  test.skip(!TARGET.exists, TARGET.missingReason);
  test.skip(
    () => appIsRunning(),
    `${APP_NAME} is already running — a second launch takes the single-instance path and never makes a boot-restore decision.`,
  );

  test('a cold single-file open suppresses a non-empty restore snapshot', async () => {
    test.setTimeout(180_000);

    const project = makeProjectFixture();
    const loose = makeLooseFile();

    try {
      await establishRestoreSnapshot(project.file);

      const since = launchViaLaunchServices(loose.file);
      const decision = await waitForBootDecision(since);

      // Load-bearing: with an empty snapshot a single-file launch still yields
      // `action: none`, so without this the case passes while proving nothing.
      // A 0 here means the precondition never took, NOT that precedence broke.
      expect(
        decision.snapshotWindowCount,
        'the app booted with an empty snapshot, so the suppression under test was never exercised',
      ).toBeGreaterThanOrEqual(1);
      expect(decision.urlLaunch).toBe(true);
      expect(decision.action).toBe('none');
    } finally {
      quitAppCleanly();
      rmSync(project.dir, { recursive: true, force: true });
      rmSync(loose.dir, { recursive: true, force: true });
    }
  });

  test('a cold launch that opens no window of its own still lands on the Navigator', async () => {
    test.setTimeout(180_000);

    // A share for a repo this machine does not hold takes the foreign-host
    // gate, and every remaining branch there declines without opening a
    // window. Suppressing the restore removed what used to mask that, so the
    // boot must recover to the Navigator. Left unhandled the app runs with no
    // window at all, which off macOS is unrecoverable: `window-all-closed`
    // fires only when a window closes, and none was ever created.
    const project = makeProjectFixture();
    const share = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';

    try {
      await establishRestoreSnapshot(project.file);

      const since = launchViaLaunchServices(share);
      const decision = await waitForBootDecision(since);
      expect(
        decision.snapshotWindowCount,
        'the app booted with an empty snapshot, so the suppression under test was never exercised',
      ).toBeGreaterThanOrEqual(1);
      expect(decision.action).toBe('none');

      await expect(() => {
        const opened = readLogLinesSince(since).some(
          (e) => e.subsystem === 'navigator' && e.msg === 'opening window',
        );
        expect(opened, 'boot suppressed the restore but opened no window').toBe(true);
      }).toPass({ timeout: 30_000, intervals: [500] });
    } finally {
      quitAppCleanly();
      rmSync(project.dir, { recursive: true, force: true });
    }
  });
});
