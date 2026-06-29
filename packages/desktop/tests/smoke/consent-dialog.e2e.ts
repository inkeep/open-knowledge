
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
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

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
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmpHome,
      OK_DESKTOP_E2E_SMOKE: '1',
      ...(opts.pickedPath !== undefined ? { OK_DESKTOP_TEST_PICKED_PATH: opts.pickedPath } : {}),
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

async function expandAdvancedSettings(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="consent-advanced-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
}

const cleanupTargets: string[] = [];
function trackForCleanup(...paths: string[]): void {
  cleanupTargets.push(...paths);
}

test.describe('Consent-dialog smoke', () => {
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
      } catch {
      }
    }
  });

  test('Enter on a focused dialog input fires Start', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('enter-to-start');
    const projectDir = seedFreshNonGitProject('enter-to-start');
    trackForCleanup(tmpHome, projectDir);

    const app = await launchApp(tmpHome, { pickedPath: projectDir });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-open"]').click();
    await expandAdvancedSettings(navigator);
    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });

    await contentDir.focus();
    await contentDir.press('Enter');

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
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

    await navigator.locator('[data-testid="nav-open"]').click();
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

    await navigator.locator('[data-testid="nav-open"]').click();
    await expandAdvancedSettings(navigator);

    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });
    await expect(contentDir).toHaveValue('.');

    const startBtn = navigator.locator('[data-testid="consent-start"]');
    await startBtn.click();

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(repoRoot, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
    expect(existsSync(join(subFolder, '.ok', 'config.yml'))).toBe(false);

    const cfg = readFileSync(join(repoRoot, '.ok', 'config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*docs/m);
    expect(cfg).toMatch(/^# content:/m);
  });
});
