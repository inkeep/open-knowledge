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
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { reapDetachedServers } from './_helpers/electron-cleanup';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { seedMcpConsentComplete } from './_helpers/mcp-consent';
import { clickNavOpen } from './_helpers/navigator-actions';
import {
  homeEnv,
  PLATFORM_SKIP_REASON,
  PLATFORM_SUPPORTED,
  SMOKE_ENABLED,
} from './_helpers/platform-gate';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

function seedTmpHome(prefix: string): string {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-consent-dialog-${prefix}-`)));
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

function seedFreshNonGitProject(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ok-consent-${prefix}-fresh-`)));
}

function seedGitRepoWithSubFolder(
  tmpHome: string,
  prefix: string,
): { repoRoot: string; subFolder: string } {
  const repoRoot = join(tmpHome, `ok-consent-${prefix}-git`);
  mkdirSync(repoRoot, { recursive: true });
  execSync('git init -q', { cwd: repoRoot });
  const subFolder = join(repoRoot, 'docs');
  mkdirSync(subFolder, { recursive: true });
  return { repoRoot, subFolder };
}

interface LaunchOpts {
  pickedPath?: string;
}

async function launchApp(tmpHome: string, opts: LaunchOpts = {}): Promise<ElectronApplication> {
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  seedMcpConsentComplete(tmpHome);
  return electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ...homeEnv(tmpHome),
        OK_DESKTOP_E2E_SMOKE: '1',
        ...(opts.pickedPath !== undefined ? { OK_DESKTOP_TEST_PICKED_PATH: opts.pickedPath } : {}),
      },
    }),
  );
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

async function expandAdvancedSettings(page: Page): Promise<void> {
  const contentDir = page.locator('[data-testid="consent-content-dir"]');
  if (await contentDir.isVisible().catch(() => false)) {
    return;
  }

  const trigger = page.locator('[data-testid="consent-advanced-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click({ force: true });
  await expect(contentDir).toBeVisible({ timeout: 15_000 });
}

const cleanupTargets: string[] = [];
function trackForCleanup(...paths: string[]): void {
  cleanupTargets.push(...paths);
}

test.describe('Consent-dialog smoke', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  test.afterEach(async () => {
    const targets = cleanupTargets.splice(0);
    reapDetachedServers(targets);
    for (const target of targets) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  test('Enter on a focused dialog input fires Start', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('enter-to-start');
    const projectDir = seedFreshNonGitProject('enter-to-start');
    trackForCleanup(tmpHome, projectDir);

    const app = await launchApp(tmpHome, { pickedPath: projectDir });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavOpen(navigator);
    await expandAdvancedSettings(navigator);
    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });
    await expect(navigator.locator('[data-testid="consent-start"]')).toBeEnabled({
      timeout: 30_000,
    });

    await contentDir.focus();
    await contentDir.press('Enter');

    await findWindowByMode(app, 'editor', 30_000);
    await expect
      .poll(() => existsSync(join(projectDir, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
  });

  test('Browse button populates content.dir with project-relative path', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('browse');
    const projectDir = seedFreshNonGitProject('browse');
    trackForCleanup(tmpHome, projectDir);

    const app = await launchApp(tmpHome, { pickedPath: projectDir });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavOpen(navigator);
    await expandAdvancedSettings(navigator);

    const contentDirInput = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDirInput).toBeVisible({ timeout: 15_000 });

    await contentDirInput.fill('docs');
    await expect(contentDirInput).toHaveValue('docs');

    const browseBtn = navigator.locator('[data-testid="consent-content-dir-browse"]');
    await expect(browseBtn).toBeVisible();
    await browseBtn.click();

    await expect(contentDirInput).toHaveValue('.', { timeout: 15_000 });
  });

  test('Pick Existing on a sub-folder of a git repo lands .ok/ at the git root', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('git-root-promote');
    const { repoRoot, subFolder } = seedGitRepoWithSubFolder(tmpHome, 'git-root-promote');
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedPath: subFolder });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await clickNavOpen(navigator);
    await expandAdvancedSettings(navigator);

    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });
    await expect(contentDir).toHaveValue('.');

    const startBtn = navigator.locator('[data-testid="consent-start"]');
    await startBtn.click();

    await findWindowByMode(app, 'editor', 30_000);
    await expect
      .poll(() => existsSync(join(repoRoot, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
    expect(existsSync(join(subFolder, '.ok', 'config.yml'))).toBe(false);

    const cfg = readFileSync(join(repoRoot, '.ok', 'config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*docs/m);
    expect(cfg).toMatch(/^# content:/m);
  });
});
