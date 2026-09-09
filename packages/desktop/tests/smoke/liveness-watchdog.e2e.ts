import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
  userDataDirFor,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const STALL_THRESHOLD_MS = 15_000;
const FREEZE_MS = 90_000;

type BootBreadcrumb = Record<string, unknown> & { event: 'crash-detection.boot'; time: string };

interface WitnessRecord {
  bootId: string;
  blockedForMs: number;
  mainTicksObserved: number;
}

function readBootBreadcrumbs(tmpHome: string): BootBreadcrumb[] {
  const logsDir = join(tmpHome, '.ok', 'logs');
  if (!existsSync(logsDir)) return [];
  const lines = readdirSync(logsDir)
    .filter((name) => name.startsWith('desktop.') && name.endsWith('.log'))
    .flatMap((name) => readFileSync(join(logsDir, name), 'utf8').split('\n'));
  const out: BootBreadcrumb[] = [];
  for (const line of lines) {
    if (!line.includes('crash-detection.boot')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event === 'crash-detection.boot') out.push(parsed as BootBreadcrumb);
    } catch {}
  }
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function readWitness(tmpHome: string): WitnessRecord | null {
  const path = join(userDataDirFor(tmpHome), 'bug-report-main-thread-liveness.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WitnessRecord;
  } catch {
    return null;
  }
}

async function launchIsolated(tmpHome: string): Promise<ElectronApplication> {
  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDirFor(tmpHome)}`],
      env: homeEnv(tmpHome),
      timeout: 30_000,
    }),
  );
  await app.firstWindow({ timeout: 20_000 });
  return app;
}

async function waitForWitnessPings(tmpHome: string, minPings: number): Promise<void> {
  await expect
    .poll(() => readWitness(tmpHome)?.mainTicksObserved ?? -1, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(minPings);
}

function killProcessTree(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGKILL');
  }
  return exited;
}

function freezeMainThread(app: ElectronApplication, ms: number): { settled: () => boolean } {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  void app
    .evaluate((_electron, freezeMs) => {
      const end = Date.now() + freezeMs;
      while (Date.now() < end) {}
    }, ms)
    .then(markSettled, markSettled);
  return { settled: () => settled };
}

async function relaunchAndReadBreadcrumb(
  tmpHome: string,
  captureStderrFor: (app: ElectronApplication, opts?: { cleanupDirs?: readonly string[] }) => void,
): Promise<BootBreadcrumb> {
  const app = await launchIsolated(tmpHome);
  captureStderrFor(app, { cleanupDirs: [tmpHome] });
  let breadcrumb: BootBreadcrumb | undefined;
  await expect(async () => {
    breadcrumb = readBootBreadcrumbs(tmpHome).at(-1);
    expect(breadcrumb).toBeDefined();
  }).toPass({ timeout: 20_000 });
  if (breadcrumb === undefined)
    throw new Error('no crash-detection.boot breadcrumb after relaunch');
  return breadcrumb;
}

test.describe('liveness watchdog separates a frozen main thread from a dead one (PRD-8439)', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test('a main thread frozen past the stall threshold, then killed, boots as blocked', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(200_000);
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-liveness-frozen-'));
    const app = await launchIsolated(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome] });
    await waitForWitnessPings(tmpHome, 1);

    const freeze = freezeMainThread(app, FREEZE_MS);
    await expect
      .poll(() => readWitness(tmpHome)?.blockedForMs ?? 0, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(STALL_THRESHOLD_MS + 5_000);
    expect(freeze.settled()).toBe(false);
    await killProcessTree(app);

    const breadcrumb = await relaunchAndReadBreadcrumb(tmpHome, captureStderrFor);
    console.log('[liveness-watchdog] frozen-then-killed breadcrumb', JSON.stringify(breadcrumb));
    expect(breadcrumb.dirtyShutdown).toBe(true);
    expect(breadcrumb.livenessVerdict).toBe('blocked');
    expect(breadcrumb.mainThreadBlockedForMs).toBeGreaterThanOrEqual(STALL_THRESHOLD_MS);
  });

  test('a main thread killed while responsive boots as died', async ({ captureStderrFor }) => {
    test.setTimeout(120_000);
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-liveness-died-'));
    const app = await launchIsolated(tmpHome);
    captureStderrFor(app, { cleanupDirs: [tmpHome] });
    await waitForWitnessPings(tmpHome, 2);

    await killProcessTree(app);

    const breadcrumb = await relaunchAndReadBreadcrumb(tmpHome, captureStderrFor);
    console.log('[liveness-watchdog] died breadcrumb', JSON.stringify(breadcrumb));
    expect(breadcrumb.dirtyShutdown).toBe(true);
    expect(breadcrumb.livenessVerdict).toBe('died');
  });
});
