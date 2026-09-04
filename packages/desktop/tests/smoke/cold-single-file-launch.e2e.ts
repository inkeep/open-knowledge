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

const APP_NAME = TARGET.appPath ? basename(TARGET.appPath, '.app') : 'OpenKnowledge';
const LOG_DIR = join(process.env.HOME ?? '', '.ok', 'logs');

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

function quitAppCleanly(): void {
  try {
    execFileSync('osascript', ['-e', `tell application "${APP_NAME}" to quit`], { stdio: 'pipe' });
  } catch {}
  waitForExit();
  if (appIsRunning()) {
    try {
      execFileSync('pkill', ['-x', APP_NAME], { stdio: 'pipe' });
    } catch {}
    waitForExit();
  }
}

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

async function establishRestoreSnapshot(projectFile: string): Promise<void> {
  quitAppCleanly();
  const since = launchViaLaunchServices(projectFile);
  await waitForBootDecision(since);
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
