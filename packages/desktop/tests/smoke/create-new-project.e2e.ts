import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { typeProjectName } from './_helpers/create-new-dialog';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

function seedTmpHome(prefix: string): string {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-create-new-${prefix}-`)));
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'state.json'),
    JSON.stringify({
      recentProjects: [],
      lastOpenedProject: null,
      versionPendingInstall: null,
      lastSeenVersion: null,
      lastSuccessfulCheckAt: null,
      stuckHintShown: false,
    }),
  );
  return tmpHome;
}

interface LaunchOpts {
  pickedParent?: string;
}

async function launchApp(tmpHome: string, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
      ...(opts.pickedParent !== undefined
        ? { OK_DESKTOP_TEST_PICKED_PATH: opts.pickedParent }
        : {}),
    },
  });
}

async function findWindowByMode(
  app: ElectronApplication,
  mode: 'navigator' | 'editor',
  timeoutMs = 20_000,
): Promise<Page> {
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          const m = await page
            .evaluate(() => window.okDesktop?.config?.mode)
            .catch(() => undefined);
          if (m === mode) return true;
        }
        return false;
      },
      { timeout: timeoutMs, message: `${mode} window did not appear within timeout` },
    )
    .toBe(true);
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) return page;
  }
  throw new Error(`${mode} window vanished between poll resolution and read`);
}

async function countWindowsByMode(
  app: ElectronApplication,
  mode: 'navigator' | 'editor',
): Promise<number> {
  let n = 0;
  for (const page of app.windows()) {
    const m = await page.evaluate(() => window.okDesktop?.config?.mode).catch(() => undefined);
    if (m === mode) n += 1;
  }
  return n;
}

const cleanupTargets: string[] = [];
function trackForCleanup(...paths: string[]): void {
  cleanupTargets.push(...paths);
}

test.describe('Create-new-project smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Smoke harness is darwin-only.');
  test.skip(
    !BUILD_EXISTS,
    `Main build missing at ${MAIN_ENTRY} — run "bun run build:desktop" first.`,
  );

  test.afterEach(async () => {
    for (const target of cleanupTargets.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  test('creates a new project at the named location when target is free', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('free');
    const parent = join(tmpHome, 'projects-free');
    mkdirSync(parent, { recursive: true });
    const projectName = 'MySmokeProject';
    const expectedTarget = join(parent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-create-new"]').click();

    const dialog = navigator.locator('[data-testid="create-project-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();

    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      parent,
      { timeout: 15_000 },
    );

    await typeProjectName(navigator, projectName);
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(
      expectedTarget,
      { timeout: 15_000 },
    );
    await expect(navigator.locator('[data-testid="create-banner-nested"]')).toHaveCount(0);
    await expect(navigator.locator('[data-testid="create-banner-git-confirm"]')).toHaveCount(0);

    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(expectedTarget, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
  });

  test('blocks creation when chosen Location is inside an existing OK project', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('nested');
    const rootPath = join(tmpHome, 'existing-project');
    mkdirSync(join(rootPath, '.ok'), { recursive: true });
    writeFileSync(join(rootPath, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const subFolder = join(rootPath, 'sub');
    mkdirSync(subFolder, { recursive: true });
    const projectName = 'Nested';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: subFolder });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      subFolder,
      { timeout: 15_000 },
    );
    await typeProjectName(navigator, projectName);

    const nestedBanner = navigator.locator('[data-testid="create-banner-nested"]');
    await expect(nestedBanner).toBeVisible({ timeout: 15_000 });
    await expect(nestedBanner).toContainText(rootPath);
    await expect(navigator.locator('[data-testid="create-banner-nested-open"]')).toBeVisible();
    await expect(navigator.locator('[data-testid="create-submit"]')).toBeDisabled();
  });

  test('promotes project root to git root; content.dir defaults to the git root, not the picked sub-folder', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('git-confirm');
    const repoRoot = join(tmpHome, 'website');
    mkdirSync(repoRoot, { recursive: true });
    execSync('git init -q', { cwd: repoRoot });
    const pickedParent = join(repoRoot, 'notes');
    mkdirSync(pickedParent, { recursive: true });
    const projectName = 'MyProj';
    const target = join(pickedParent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      pickedParent,
      { timeout: 5_000 },
    );
    await typeProjectName(navigator, projectName);
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(target, {
      timeout: 5_000,
    });

    const gitBanner = navigator.locator('[data-testid="create-banner-git-confirm"]');
    await expect(gitBanner).toBeVisible({ timeout: 15_000 });
    await expect(gitBanner).toContainText(repoRoot);
    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(repoRoot, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
    expect(existsSync(join(target, '.ok', 'config.yml'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    const cfg = readFileSync(join(repoRoot, '.ok', 'config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*notes\/MyProj/m);
    expect(cfg).toMatch(/^# content:/m);
  });

  test('PRD-6649: cascade banner DOM node survives a verdict-content change of the same kind (no flicker, real Electron renderer)', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('prd6649-noflicker');

    const proj1Root = join(tmpHome, 'existing-project-1');
    mkdirSync(join(proj1Root, '.ok'), { recursive: true });
    writeFileSync(join(proj1Root, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const sub1 = join(proj1Root, 'sub');
    mkdirSync(sub1, { recursive: true });

    const proj2Root = join(tmpHome, 'existing-project-2');
    mkdirSync(join(proj2Root, '.ok'), { recursive: true });
    writeFileSync(join(proj2Root, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const sub2 = join(proj2Root, 'sub');
    mkdirSync(sub2, { recursive: true });

    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: `${sub1}\x1f${sub2}` });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await typeProjectName(navigator, 'NestedX');

    await navigator.locator('[data-testid="create-browse"]').click();
    const nestedBanner = navigator.locator('[data-testid="create-banner-nested"]');
    await expect(nestedBanner).toBeVisible({ timeout: 15_000 });
    await expect(nestedBanner).toContainText(proj1Root);

    await navigator.evaluate(() => {
      const banner = document.querySelector('[data-testid="create-banner-nested"]');
      if (banner === null || banner.parentElement === null) {
        throw new Error('banner or its parent not found at observer install');
      }
      banner.setAttribute('data-prd6649-marker', 'initial');
      const state: {
        bannerWasRemoved: boolean;
        initialBanner: Element;
        observer: MutationObserver;
      } = {
        bannerWasRemoved: false,
        initialBanner: banner,
        observer: new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const removed of Array.from(m.removedNodes)) {
              if (
                removed === state.initialBanner ||
                (removed instanceof Element && removed.contains(state.initialBanner))
              ) {
                state.bannerWasRemoved = true;
              }
            }
          }
        }),
      };
      state.observer.observe(banner.parentElement, { childList: true, subtree: true });
      (window as unknown as { __prd6649: typeof state }).__prd6649 = state;
    });

    await navigator.locator('[data-testid="create-browse"]').click();

    await expect(nestedBanner).toContainText(proj2Root, { timeout: 15_000 });
    await expect(nestedBanner).not.toContainText(proj1Root);

    const result = await navigator.evaluate(() => {
      const s = (
        window as unknown as {
          __prd6649: {
            bannerWasRemoved: boolean;
            initialBanner: Element;
            observer: MutationObserver;
          };
        }
      ).__prd6649;
      s.observer.disconnect();
      const current = document.querySelector('[data-testid="create-banner-nested"]');
      return {
        bannerWasRemoved: s.bannerWasRemoved,
        stillConnected: s.initialBanner.isConnected,
        sameNode: current === s.initialBanner,
        markerSurvived: s.initialBanner.getAttribute('data-prd6649-marker') === 'initial',
      };
    });

    expect(result.bannerWasRemoved).toBe(false);
    expect(result.stillConnected).toBe(true);
    expect(result.sameNode).toBe(true);
    expect(result.markerSurvived).toBe(true);
  });

  test('PRD-6649: idle confirm-git dialog does not flash on 5 s poll ticks (zero interaction, real Electron renderer)', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('prd6649-idle-poll');
    const repoRoot = join(tmpHome, 'some-checkout');
    mkdirSync(repoRoot, { recursive: true });
    execSync('git init -q', { cwd: repoRoot });
    const pickedParent = join(repoRoot, 'docs');
    mkdirSync(pickedParent, { recursive: true });
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await typeProjectName(navigator, 'Notes');
    await navigator.locator('[data-testid="create-browse"]').click();
    const gitBanner = navigator.locator('[data-testid="create-banner-git-confirm"]');
    await expect(gitBanner).toBeVisible({ timeout: 15_000 });
    await expect(gitBanner).toContainText(repoRoot);

    await navigator.evaluate(() => {
      const banner = document.querySelector('[data-testid="create-banner-git-confirm"]');
      if (banner === null || banner.parentElement === null) {
        throw new Error('confirm-git banner or its parent not found at observer install');
      }
      banner.setAttribute('data-prd6649-marker', 'idle');
      const state: {
        bannerWasRemoved: boolean;
        initialBanner: Element;
        observer: MutationObserver;
      } = {
        bannerWasRemoved: false,
        initialBanner: banner,
        observer: new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const removed of Array.from(m.removedNodes)) {
              if (
                removed === state.initialBanner ||
                (removed instanceof Element && removed.contains(state.initialBanner))
              ) {
                state.bannerWasRemoved = true;
              }
            }
          }
        }),
      };
      state.observer.observe(banner.parentElement, { childList: true, subtree: true });
      (window as unknown as { __prd6649idle: typeof state }).__prd6649idle = state;
    });

    await navigator.waitForTimeout(12_000);

    await expect(gitBanner).toContainText(repoRoot);

    const result = await navigator.evaluate(() => {
      const s = (
        window as unknown as {
          __prd6649idle: {
            bannerWasRemoved: boolean;
            initialBanner: Element;
            observer: MutationObserver;
          };
        }
      ).__prd6649idle;
      s.observer.disconnect();
      const current = document.querySelector('[data-testid="create-banner-git-confirm"]');
      return {
        bannerWasRemoved: s.bannerWasRemoved,
        stillConnected: s.initialBanner.isConnected,
        sameNode: current === s.initialBanner,
        markerSurvived: s.initialBanner.getAttribute('data-prd6649-marker') === 'idle',
      };
    });

    expect(result.bannerWasRemoved).toBe(false);
    expect(result.stillConnected).toBe(true);
    expect(result.sameNode).toBe(true);
    expect(result.markerSurvived).toBe(true);
  });
});
