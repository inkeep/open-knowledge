/**
 * Extended scenarios for create-new-project dialog.
 *
 * These tests cover scenarios beyond the 3-test smoke (free / nested / git
 * promote): editor customization, location persistence, IPC error surfacing,
 * keyboard navigation, double-click idempotency, sanitization preview, ARIA
 * roles, probe debounce/cache behavior. The basic smoke harness pattern
 * (env-var test seam, mkdtemp HOME, --user-data-dir) is reused verbatim.
 *
 * The renderer-only busy-state dismissal guard (onOpenChangeInternal's
 * `if (busy) return`) is exercised in CreateProjectDialog.runtime.dom.test.tsx,
 * not here — it needs an in-flight createNew the DOM tier can hold open
 * deterministically.
 *
 * Name-first model. Browse picks the **parent**; the project
 * basename is supplied by typing into the Name <Input>. Tests set
 * `OK_DESKTOP_TEST_PICKED_PATH = parent` and use the `typeProjectName`
 * helper to fill the name.
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
import { typeProjectName } from './_helpers/create-new-dialog';
import { captureAppProcess, closeAppBounded } from './_helpers/electron-cleanup';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);
const DESKTOP_PRODUCT_NAME = '@inkeep/open-knowledge-desktop';

/**
 * Editor controls live inside the collapsed "Advanced settings" section (Radix
 * unmounts collapsed content) — expand it before driving or asserting on those
 * checkboxes. (Config sharing is top-level, not in Advanced.)
 */
async function expandCreateAdvanced(page: Page): Promise<void> {
  const trigger = page.locator('[data-testid="create-advanced-trigger"]');
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await trigger.click();
}

function seedTmpHome(prefix: string, stateOverride?: Record<string, unknown>): string {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), `ok-qa-${prefix}-`)));
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
      ...stateOverride,
    }),
  );
  return tmpHome;
}

interface LaunchOpts {
  /**
   * Parent directory the OK_DESKTOP_TEST_PICKED_PATH seam returns. The
   * project basename comes from the Name input.
   */
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

test.describe('QA extended create-new-project', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run.');
  test.skip(!DARWIN, 'Darwin-only.');
  test.skip(!BUILD_EXISTS, 'Run "bun run build:desktop" first.');

  test.afterEach(async () => {
    for (const target of cleanupTargets.splice(0)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });

  // editor customization → only chosen editors land on
  // disk; aria roles; telemetry variant via flow_kind attribute.
  test('QA-005 editor customization writes only checked editors', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('editors');
    const parent = join(tmpHome, 'projects');
    mkdirSync(parent, { recursive: true });
    const projectName = 'Customized';
    const expected = join(parent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();

    // confirm-git banner role=status; nested banner role=alert;
    // nonempty banner role=alert. We assert on rendered ones in
    // separate tests. Here in editors-test we focus on customization.
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      parent,
      { timeout: 5_000 },
    );
    await typeProjectName(navigator, projectName);
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(
      expected,
      { timeout: 5_000 },
    );

    // Uncheck cursor + codex. EDITOR IDs from cli (NOT 'claude-code').
    await expandCreateAdvanced(navigator);
    await navigator.locator('[data-testid="create-editor-cursor"]').click();
    await navigator.locator('[data-testid="create-editor-codex"]').click();
    // Verify state: claude + claude-desktop checked; cursor + codex unchecked.
    await expect(navigator.locator('[data-testid="create-editor-claude"]')).toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-claude-desktop"]')).toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-cursor"]')).not.toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-codex"]')).not.toBeChecked();

    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    await expect
      .poll(() => existsSync(join(expected, '.ok', 'config.yml')), { timeout: 15_000 })
      .toBe(true);

    // assertion: cursor + codex NOT present on disk.
    expect(existsSync(join(expected, '.cursor'))).toBe(false);
    expect(existsSync(join(expected, '.codex'))).toBe(false);
  });

  // dialog UX: name input is focused on open, Location is hydrated,
  // all 4 editors visible.
  test('QA-010 dialog UX — focus, location, checkboxes, ARIA', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('uxshape');
    const parent = join(tmpHome, 'projects');
    mkdirSync(parent, { recursive: true });
    const projectName = 'Live Preview';
    const expectedTarget = join(parent, projectName);
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    const dialog = navigator.locator('[data-testid="create-project-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Name input is the first focused control on open.
    await expect(navigator.locator('[data-testid="create-name"]')).toBeFocused();

    // The Location display hydrates from defaultProjectsRoot() — the
    // persisted last-used parent, else ~/Documents/OpenKnowledge.
    // It never sits empty for long.
    const locationDisplay = navigator.locator('[data-testid="create-location-display"]');
    await expect(locationDisplay).toBeVisible();

    // aria-live on the caption is 'polite' so AT users hear the resolved
    // target update as they type.
    const caption = navigator.locator('[data-testid="create-target-caption"]');
    const ariaLive = await caption.getAttribute('aria-live');
    expect(ariaLive).toBe('polite');

    // All 4 editors visible + checked initially (under Advanced settings).
    await expandCreateAdvanced(navigator);
    await expect(navigator.locator('[data-testid="create-editor-claude"]')).toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-claude-desktop"]')).toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-cursor"]')).toBeChecked();
    await expect(navigator.locator('[data-testid="create-editor-codex"]')).toBeChecked();

    // Type the name + Browse → caption shows the resolved target.
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(caption).toContainText(expectedTarget, { timeout: 15_000 });
  });

  // lastUsedProjectParent persists across app restarts (the
  // Location field on the next open is prefilled to the previously-used
  // parent); transient form state (name, editors) resets per open.
  test('QA-011 + QA-016 — lastUsedProjectParent persists across opens; transient form state resets on reopen', async ({
    captureStderrFor,
  }) => {
    // Two full Electron cold-starts (the first creates the project + persists
    // lastUsedProjectParent; the second relaunches and asserts the prefill). The
    // cumulative inner-timeout budget is ~190s — over the suite-wide 150s
    // CI per-test budget set in `playwright.config.ts`. The 2x launch is
    // structurally required by the test (cross-restart persistence cannot
    // be observed in a single launch), so this test opts into a larger
    // budget rather than fragmenting into two coupled tests. Local dev
    // keeps the suite default via CI=undefined.
    if (process.env.CI) {
      test.setTimeout(240_000);
    }
    const tmpHome = seedTmpHome('persist');
    const parent = join(tmpHome, 'projects-persist');
    mkdirSync(parent, { recursive: true });
    const userDataDir = join(tmpHome, 'Library', 'Application Support', DESKTOP_PRODUCT_NAME);
    const projectName = 'First';
    trackForCleanup(tmpHome);

    // First launch: submit a project. The handler must persist
    // lastUsedProjectParent (= the parent we picked).
    const app1 = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app1);
    // Need a ChildProcess handle here-and-now for the explicit
    // closeAppBounded call between Pass 1 and Pass 2 (the fixture's
    // bounded teardown only runs at end-of-test). captureStderrFor above
    // already registers the proc into the fixture for end-of-test
    // teardown — this is a parallel local handle for the inter-pass
    // close.
    const app1Proc = captureAppProcess(app1);
    const navigator = await findWindowByMode(app1, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      parent,
      { timeout: 15_000 },
    );
    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect
      .poll(() => countWindowsByMode(app1, 'editor'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);

    // First → second launch hand-off. Both launches share the same `tmpHome` →
    // same Electron `userData` dir. Two Electron processes against the
    // same userData would contend on Chromium's lockfile; the first must be
    // fully reaped before the second launches. Use the bounded primitive
    // (5s graceful + SIGKILL-on-process-group fallback) so the inter-pass
    // close cannot regress to the unbounded `app.close()` shape.
    await closeAppBounded(app1Proc, { gracefulMs: 5_000 });

    // Inspect state.json on disk: lastUsedProjectParent should equal `parent`.
    const stateAfterSubmit = JSON.parse(readFileSync(join(userDataDir, 'state.json'), 'utf8'));
    expect(stateAfterSubmit.lastUsedProjectParent).toBe(parent);

    // Pre-populate state.json so the next launch starts at navigator (not
    // editor). Clearing lastOpenedProject + recentProjects forces the
    // Navigator-first boot path.
    const persistedParent = stateAfterSubmit.lastUsedProjectParent;
    writeFileSync(
      join(userDataDir, 'state.json'),
      JSON.stringify({
        recentProjects: [],
        lastOpenedProject: null,
        lastUsedProjectParent: persistedParent,
        versionPendingInstall: null,
        lastSeenVersion: null,
        lastSuccessfulCheckAt: null,
        stuckHintShown: false,
      }),
    );

    // Second launch: relaunch. Location prefills from lastUsedProjectParent;
    // the Name input resets to empty; editor checkboxes reset to checked.
    const app2 = await launchApp(tmpHome);
    captureStderrFor(app2);
    const navigator2 = await findWindowByMode(app2, 'navigator', 30_000);
    await navigator2.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator2.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    // Name resets to empty on each fresh open.
    const nameInput = navigator2.locator('[data-testid="create-name"]');
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue('');
    // Location prefills from the persisted last-used parent.
    await expect(navigator2.locator('[data-testid="create-location-display"]')).toContainText(
      persistedParent,
      { timeout: 15_000 },
    );
    await expandCreateAdvanced(navigator2);
    await expect(navigator2.locator('[data-testid="create-editor-claude"]')).toBeChecked();
    await expect(navigator2.locator('[data-testid="create-editor-claude-desktop"]')).toBeChecked();
    await expect(navigator2.locator('[data-testid="create-editor-cursor"]')).toBeChecked();
    await expect(navigator2.locator('[data-testid="create-editor-codex"]')).toBeChecked();
  });

  // Create stays enabled even before the user types a name — a disabled
  // button gives no hint why. Submitting with no name does not create or
  // navigate (it surfaces an "Enter a project name" toast — asserted
  // deterministically in CreateProjectDialog.runtime.dom.test.tsx; the
  // transient portal toast is not reliably catchable in Electron
  // Playwright). Typing a name + Browse then enables real creation.
  test('submit with no name does not create; typing the name enables creation', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('toast-when-empty');
    const parent = join(tmpHome, 'projects-san');
    mkdirSync(parent, { recursive: true });
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    // Before name: empty input, but submit is ENABLED so the click can
    // explain the requirement.
    const nameInput = navigator.locator('[data-testid="create-name"]');
    await expect(nameInput).toHaveValue('');
    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();
    const caption = navigator.locator('[data-testid="create-target-caption"]');
    // Pre-name, caption is empty (no resolved target to show yet).
    await expect(caption).toHaveText('', { timeout: 5_000 });

    // Clicking with no name must NOT create a project: the dialog stays open
    // and no editor window opens. Give a real chance for an (erroneous) editor
    // window to appear before asserting none did.
    await submit.click();
    await navigator.waitForTimeout(2_000);
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible();
    expect(await countWindowsByMode(app, 'editor')).toBe(0);

    // Type the name + Browse → caption shows the resolved path and submit
    // stays enabled for real creation.
    await typeProjectName(navigator, 'AfterPick');
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(caption).toContainText(join(parent, 'AfterPick'), { timeout: 15_000 });
    await expect(submit).toBeEnabled();
  });

  // double-click does not fire two IPCs.
  test('QA-019 — double-click Create produces exactly one project', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('dblclick');
    const parent = join(tmpHome, 'projects-dbl');
    mkdirSync(parent, { recursive: true });
    const projectName = 'Unique';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(
      join(parent, projectName),
      { timeout: 15_000 },
    );

    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled();

    // Rapid double-click: button should become disabled after first click,
    // second click is a no-op.
    await submit.click();
    // Best-effort second click; should be ignored.
    try {
      await submit.click({ timeout: 1_000, force: true });
    } catch {
      // Expected: button disabled.
    }

    // Exactly one editor window opens. Wait a generous timeout to confirm
    // a second window doesn't appear.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    // Wait via setTimeout (navigator window may close after editor opens).
    await new Promise((r) => setTimeout(r, 2_000));
    const editorCount = await countWindowsByMode(app, 'editor');
    expect(editorCount).toBe(1);
    // And exactly one project dir on disk.
    expect(existsSync(join(parent, projectName, '.ok', 'config.yml'))).toBe(true);
  });

  // banner ARIA roles (nested role=alert, confirm-git
  // role=status, nonempty role=alert).
  test('QA-025 — banner ARIA roles per severity', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('aria');
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
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      subFolder,
      { timeout: 15_000 },
    );

    // Nested banner: role=alert.
    const nestedBanner = navigator.locator('[data-testid="create-banner-nested"]');
    await expect(nestedBanner).toBeVisible({ timeout: 15_000 });
    const nestedRole = await nestedBanner.getAttribute('role');
    expect(nestedRole).toBe('alert');
  });

  // confirm-git banner has role=status, aria-live=polite.
  test('QA-025b — git-confirm banner role=status, aria-live=polite', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('aria-git');
    const repoRoot = join(tmpHome, 'website');
    mkdirSync(repoRoot, { recursive: true });
    execSync('git init -q', { cwd: repoRoot });
    const pickedParent = join(repoRoot, 'notes');
    mkdirSync(pickedParent, { recursive: true });
    const projectName = 'MyProj';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      pickedParent,
      { timeout: 15_000 },
    );

    const gitBanner = navigator.locator('[data-testid="create-banner-git-confirm"]');
    await expect(gitBanner).toBeVisible({ timeout: 15_000 });
    const role = await gitBanner.getAttribute('role');
    expect(role).toBe('status');
    const ariaLive = await gitBanner.getAttribute('aria-live');
    expect(ariaLive).toBe('polite');
  });

  // Keyboard submit: pressing Enter while focused on the Submit button
  // submits the form (load-bearing for keyboard users who never reach
  // for the mouse).
  test('Enter on Submit button submits the form', async ({ captureStderrFor }) => {
    const tmpHome = seedTmpHome('kbd');
    const parent = join(tmpHome, 'projects-kbd');
    mkdirSync(parent, { recursive: true });
    const projectName = 'KbdSubmit';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-target-caption"]')).toContainText(
      join(parent, projectName),
      { timeout: 15_000 },
    );

    // Wait for cascade to settle (free state).
    const submit = navigator.locator('[data-testid="create-submit"]');
    await expect(submit).toBeEnabled({ timeout: 10_000 });

    // Press Enter while focused on the Submit button. Form should submit.
    await submit.focus();
    await submit.press('Enter');

    await expect
      .poll(() => countWindowsByMode(app, 'editor'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    expect(existsSync(join(parent, projectName, '.ok', 'config.yml'))).toBe(true);
  });

  // inline "Open <basename>" action: clicking opens that project.
  test('QA-002 — clicking Open <basename> dispatches openProject and closes dialog', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('open-nested');
    const rootPath = join(tmpHome, 'NestedTarget');
    mkdirSync(join(rootPath, '.ok'), { recursive: true });
    writeFileSync(join(rootPath, '.ok', 'config.yml'), 'schemaVersion: 1\ncontent:\n  dir: "."\n');
    const subFolder = join(rootPath, 'sub');
    mkdirSync(subFolder, { recursive: true });
    const projectName = 'Anything';
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: subFolder });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-name"]')).toBeVisible();
    await typeProjectName(navigator, projectName);
    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      subFolder,
      { timeout: 15_000 },
    );

    const openBtn = navigator.locator('[data-testid="create-banner-nested-open"]');
    await expect(openBtn).toBeVisible({ timeout: 15_000 });
    // Button label includes the basename of the enclosing project.
    await expect(openBtn).toHaveText(/Open NestedTarget/);
    await openBtn.click();

    // Editor window for the existing project should open. The dialog
    // closes (typically by the navigator window itself closing once an
    // editor window opens). Asserting "editor opened" + "dialog gone"
    // covers either route: dialog DOM unmounted or navigator window closed.
    await expect
      .poll(() => countWindowsByMode(app, 'editor'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    // Either the navigator is gone or the dialog is no longer visible.
    const navStillAlive = !navigator.isClosed();
    if (navStillAlive) {
      await expect(navigator.locator('[data-testid="create-project-dialog"]')).not.toBeVisible({
        timeout: 5_000,
      });
    }
  });

  // Name-field inline validation: a name resolving to an
  // existing non-empty folder shows inline `create-name-error-taken`
  // and disables Create — no separate subfolder input.
  test('PRD-7129 — name resolving to a non-empty folder shows inline name-taken error', async ({
    captureStderrFor,
  }) => {
    const tmpHome = seedTmpHome('name-taken');
    const parent = join(tmpHome, 'projects-taken');
    mkdirSync(parent, { recursive: true });
    // Seed a non-empty folder at parent/Notes.
    const taken = join(parent, 'Notes');
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'existing.md'), '# existing\n');
    trackForCleanup(tmpHome);

    const app = await launchApp(tmpHome, { pickedParent: parent });
    captureStderrFor(app);
    const navigator = await findWindowByMode(app, 'navigator');
    await navigator.locator('[data-testid="nav-create-new"]').click();
    await expect(navigator.locator('[data-testid="create-project-dialog"]')).toBeVisible({
      timeout: 15_000,
    });

    await navigator.locator('[data-testid="create-browse"]').click();
    await expect(navigator.locator('[data-testid="create-location-display"]')).toContainText(
      parent,
      { timeout: 15_000 },
    );

    // Type the name of the existing non-empty folder.
    await typeProjectName(navigator, 'Notes');

    // Inline name-taken error appears on the name field; Create disabled;
    // no standalone subfolder-rescue input.
    await expect(navigator.locator('[data-testid="create-name-error-taken"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-submit"]')).toBeDisabled();
    await expect(navigator.locator('[data-testid="create-subfolder-rescue"]')).toHaveCount(0);

    // Switching to a different name clears the inline error.
    await typeProjectName(navigator, 'FreshNotes');
    await expect(navigator.locator('[data-testid="create-name-error-taken"]')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(navigator.locator('[data-testid="create-submit"]')).toBeEnabled({
      timeout: 15_000,
    });
  });
});
