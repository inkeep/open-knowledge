/**
 * Consent-dialog smoke harness — drives an Electron launch through the
 * Navigator → Pick Existing folder pick → consent dialog flow and asserts
 * the onboarding contract:
 *
 *   1. Enter on a focused dialog input fires Start (form submit identical
 *      to clicking the Start button).
 *   2. Pick Existing on a sub-folder of a git repo lands `.ok/` at the
 *      git root, NOT at the sub-folder (git-root promotion).
 *   3. Browse button on the consent dialog populates the content.dir field
 *      with a project-relative path picked from the native folder picker.
 *
 * Create-new-project coverage lives in `create-new-project.e2e.ts` — that
 * flow no longer routes through this consent dialog.
 *
 * The native folder picker is bypassed via the `OK_DESKTOP_TEST_PICKED_PATH`
 * env-var seam in `dialog-helpers.ts` — gated by `OK_DESKTOP_E2E_SMOKE=1`
 * so the seam can never fire in production.
 *
 * Skip gates mirror `navigator-return.e2e.ts` — opt-in via
 * `OK_DESKTOP_E2E_SMOKE=1`, darwin-only, and build-must-exist.
 */

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
  // Realpath: macOS's tmpdir() resolves /var/folders → /private/var/folders.
  // folder-admission's `isDescendantOfHome` compares realpathSync(picked) to
  // homedir() (the literal HOME env). If HOME is the un-realpathed tmpdir
  // path, the descendant check fails and git-root promotion never fires.
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-consent-dialog-${prefix}-`)));
  const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
  mkdirSync(userDataDir, { recursive: true });
  // Empty state.json so the app boots straight to the Navigator (no
  // lastOpenedProject; the editor branch never fires).
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

/**
 * Seed a git repo INSIDE the test home so folder-admission's
 * `isDescendantOfHome` gate accepts the git-root promotion. The tmpHome
 * passed in is the same one launched as `HOME` for the Electron process.
 */
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
  // `--user-data-dir` is the only reliable way to redirect Electron's
  // app.getPath('userData') on macOS — setting HOME doesn't work because
  // NSHomeDirectory() resolves via getpwuid(), not the env. Without this,
  // every smoke test reads/writes the developer's real Library/Application
  // Support state and `lastOpenedProject` from real usage causes the editor
  // window to spawn instead of the navigator.
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

/**
 * The content.dir / ignore / AI-tool controls collapse into an "Advanced
 * settings" section by default — the dialog reads as a confirmation screen.
 * Expand it before driving any of those fields. (Config sharing is top-level,
 * not in Advanced.)
 */
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
        // best-effort
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
    // content.dir now lives inside the collapsed "Advanced settings" section.
    await expandAdvancedSettings(navigator);
    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });

    // Focus the field and press Enter — Start must fire (form onSubmit
    // routes through onConfirm, identical to clicking the Start button).
    await contentDir.focus();
    await contentDir.press('Enter');

    // Editor window opens AND .ok/config.yml lands — proves Enter actually
    // submitted the form, not just dismissed something.
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

    // Both the Pick Existing folder pick AND the Browse-from-dialog pick
    // resolve through the same OK_DESKTOP_TEST_PICKED_PATH env-var seam in
    // dialog-helpers.ts. By pointing it at the project root, Browse returns
    // projectDir → ConsentDialogBody computes the relative path as '.'.
    // Tests the full wire (click → IPC → main handler → relativeToProject →
    // setContentDir) without needing a way to swap the env var mid-session.
    const app = await launchApp(tmpHome, { pickedPath: projectDir });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');

    await navigator.locator('[data-testid="nav-open"]').click();
    await expandAdvancedSettings(navigator);

    const contentDirInput = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDirInput).toBeVisible({ timeout: 15_000 });

    // Type a non-default value first so we can assert the Browse click
    // overwrites it (otherwise the seeded default '.' would mask a no-op).
    await contentDirInput.fill('docs');
    await expect(contentDirInput).toHaveValue('docs');

    const browseBtn = navigator.locator('[data-testid="consent-content-dir-browse"]');
    await expect(browseBtn).toBeVisible();
    await browseBtn.click();

    // Browse picked projectDir (via the env-var seam) → relative resolves
    // to '.', the field value updates.
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

    // Dialog should render with git-root-promotion notice referencing the
    // git root, and the content.dir prefilled to '.' (opened folder and
    // content scope align by default — user can narrow via the field).
    const contentDir = navigator.locator('[data-testid="consent-content-dir"]');
    await expect(contentDir).toBeVisible({ timeout: 15_000 });
    await expect(contentDir).toHaveValue('.');

    const startBtn = navigator.locator('[data-testid="consent-start"]');
    await startBtn.click();

    // Editor window opens; .ok/config.yml lands at repoRoot, NOT at subFolder.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => existsSync(join(repoRoot, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);
    // The project-config `.ok/` (config.yml + .gitignore) lives only at the
    // git root. The sub-path may contain a runtime `.ok/local/` (server
    // lock + cache) — that's the contentDir-scoped server lock,
    // not a duplicated project root.
    expect(existsSync(join(subFolder, '.ok', 'config.yml'))).toBe(false);

    // content.dir defaults to '.' (the git root). Pin BOTH halves of the
    // on-disk state: (a) no uncommented `dir: docs` entry under `content:`
    // (the template writes nested YAML — `content:\n  dir: <value>` — not
    // a flat `content.dir: <value>` key, so the negative regex must match
    // the nested form), and (b) the commented `# content:` template block
    // stays in place (the exact shape `buildConfigYmlContent` writes when
    // contentDir === '.').
    const cfg = readFileSync(join(repoRoot, '.ok', 'config.yml'), 'utf8');
    expect(cfg).not.toMatch(/^\s*dir:\s*docs/m);
    expect(cfg).toMatch(/^# content:/m);
  });
});
